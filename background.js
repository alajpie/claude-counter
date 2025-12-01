import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, RawLog, addContainerFetchListener, StoredMap, getStorageValue, setStorageValue, removeStorageValue, sendTabMessage, messageRegistry, markTabReady, unmarkTab } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter, getTextFromContent } from './bg-components/tokenManagement.js';
import { ConversationData } from './bg-components/bg-dataclasses.js';
import { ClaudeAPI, ConversationAPI } from './bg-components/claude-api.js';

const INTERCEPT_PATTERNS = {
	onBeforeRequest: {
		urls: [
			"*://claude.ai/api/organizations/*/completion",
			"*://claude.ai/api/organizations/*/retry_completion",
			"*://claude.ai/api/settings/billing*"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/completion$",
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/retry_completion$",
			"^https?://claude\\.ai/api/settings/billing"
		]
	},
	onCompleted: {
		urls: [
			"*://claude.ai/api/organizations/*/chat_conversations/*"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*$"
		]
	}
};

//#region Variable declarations
let processingLock = null;  // Unix timestamp or null
const pendingTasks = [];
const LOCK_TIMEOUT = 30000;  // 30 seconds - if a task takes longer, something's wrong
let pendingRequests;

let isInitialized = false;
let functionsPendingUntilInitialization = [];

function runOnceInitialized(fn, args) {
	if (!isInitialized) {
		functionsPendingUntilInitialization.push({ fn, args });
		return;
	}
	return fn(...args);
}
//#endregion

//#region Listener setup (I hate MV3 - listeners must be initialized here)
//Extension-related listeners:
browser.runtime.onMessage.addListener(async (message, sender) => {
	return runOnceInitialized(handleMessageFromContent, [message, sender]);
});

// Track ready tabs to avoid messaging non-listener tabs
browser.tabs.onRemoved.addListener((tabId) => unmarkTab(tabId));

if (!isElectron) {
	browser.action.onClicked.addListener(() => {
		// Always open debug page when clicking the extension icon
		browser.tabs.create({
			url: browser.runtime.getURL('debug.html')
		});
	});
}


// Context menus removed for minimal build


if (!isElectron) {
	// WebRequest listeners
	browser.webRequest.onBeforeRequest.addListener(
		(details) => runOnceInitialized(onBeforeRequestHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onBeforeRequest.urls },
		["requestBody"]
	);

	// Note: We no longer use webRequest.onCompleted because it doesn't provide response bodies.
	// Instead, we use the fetch monkeypatch (interceptedResponse handler) which captures the full response.

	addContainerFetchListener();
}
//#endregion


async function Log(...args) {
	await RawLog("background", ...args)
};

async function logError(error) {
	// If object is not an error, log it as a string
	if (!(error instanceof Error)) {
		await Log("error", JSON.stringify(error));
		return
	}

	await Log("error", error.toString());
	if ("captureStackTrace" in Error) {
		Error.captureStackTrace(error, logError);
	}
	await Log("error", JSON.stringify(error.stack));
}


//#endregion


async function requestActiveOrgId(tab) {
	if (typeof tab === "number") {
		tab = await browser.tabs.get(tab);
	}
	if (chrome.cookies) {
		try {
			const cookie = await browser.cookies.get({
				name: 'lastActiveOrg',
				url: tab.url,
				storeId: tab.cookieStoreId
			});

			if (cookie?.value) {
				return cookie.value;
			}
		} catch (error) {
			await Log("error", "Error getting cookie directly:", error);
		}
	}


	try {
		const response = await sendTabMessage(tab.id, {
			action: "getOrgID"
		});
		return response?.orgId;
	} catch (error) {
		await Log("error", "Error getting org ID from content script:", error);
		return null;
	}
}

//#endregion


//#region Messaging

// Updates a specific tab with conversation metrics
async function updateTabWithConversationData(tabId, conversationData) {
	const tab = await browser.tabs.get(tabId).catch(() => null);
	if (!tab?.url || !tab.url.includes('://claude.ai/')) {
		await Log("warn", "Skipping conversation update for non-Claude tab", tabId, tab?.url);
		return;
	}
	await Log("Updating tab with conversation metrics:", tabId, conversationData);

	sendTabMessage(tabId, {
		type: 'updateConversationData',
		data: {
			conversationData: conversationData.toJSON()
		}
	});
}

// Create the registry

// Simple handlers with inline functions
messageRegistry.register('getConfig', () => CONFIG);
messageRegistry.register('initOrg', (message, sender, orgId) => tokenStorageManager.addOrgId(orgId).then(() => true));
messageRegistry.register('getNativeUsage', async (message, sender, orgId) => {
	const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);
	return api.getUsageSummary();
});
messageRegistry.register('getAPIKey', () => getStorageValue('apiKey'));
messageRegistry.register('setAPIKey', async (message) => {
	const newKey = message.newKey;
	if (newKey === "") {
		await removeStorageValue('apiKey');
		await Log("API key cleared");
		return true;
	}

	// Test the new key using count_tokens
	const isValid = await tokenCounter.testApiKey(newKey);

	if (isValid) {
		await setStorageValue('apiKey', newKey);
		await Log("API key validated and saved");
		return true;
	} else {
		await Log("warn", "API key validation failed");
		return false;
	}
});

messageRegistry.register('tabReady', (message, sender) => {
	if (sender.tab?.id !== undefined) markTabReady(sender.tab.id);
	return true;
});
messageRegistry.register('getMonkeypatchPatterns', () => INTERCEPT_PATTERNS);
// Complex handlers
async function requestData(message, sender, orgId) {
	const { conversationId } = message;
	const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);

	// If conversationId provided, send conversation metrics
	if (conversationId) {
		await Log(`Requested metrics for conversation: ${conversationId}`);
		const conversation = await api.getConversation(conversationId);
		const conversationData = await conversation.getInfo(false);
		const profileTokens = await api.getProfileTokens();

		if (conversationData) {
			// Add profile tokens to the conversation length only
			conversationData.length += profileTokens;
			await updateTabWithConversationData(sender.tab.id, conversationData);
		}
	}

	await Log("Sent update messages to tab");
	return true;
}
messageRegistry.register(requestData);

async function interceptedRequest(message, sender) {
	await Log("Got intercepted request, are we in electron?", isElectron);
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onBeforeRequestHandler(message.details);
	return true;
}
messageRegistry.register(interceptedRequest);

async function interceptedResponse(message, sender) {
	await Log("Got intercepted response");
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onCompletedHandler(message.details);
	return true;
}
messageRegistry.register(interceptedResponse);


// Main handler function
async function handleMessageFromContent(message, sender) {
	return messageRegistry.handle(message, sender);
}
//#endregion



//#region Network handling
async function parseRequestBody(requestBody) {
	if (!requestBody?.raw?.[0]?.bytes) return undefined;

	// Handle differently based on source
	if (requestBody.fromMonkeypatch) {
		const body = requestBody.raw[0].bytes;
		try {
			return JSON.parse(body);
		} catch (e) {
			try {
				const params = new URLSearchParams(body);
				const formData = {};
				for (const [key, value] of params) {
					formData[key] = value;
				}
				return formData;
			} catch (e) {
				return undefined;
			}
		}
	} else {
		// Original webRequest handling
		try {
			const text = new TextDecoder().decode(requestBody.raw[0].bytes);
			return JSON.parse(text);
		} catch (e) {
			return undefined;
		}
	}
}

async function processResponse(orgId, conversationId, responseKey, details, interceptedResponseBody = null) {
	const tabId = details.tabId;
	const api = new ClaudeAPI(details.cookieStoreId, orgId);
	await Log("Processing response...")

	const pendingRequest = await pendingRequests.get(responseKey);
	const isNewMessage = pendingRequest !== undefined;

	const conversation = await api.getConversation(conversationId);
	const conversationData = await conversation.getInfo(isNewMessage, interceptedResponseBody);
	if (!conversationData) {
		await Log("warn", "Could not get conversation tokens, exiting...")
		return false;
	}

	await Log("Current base length:", conversationData.length);

	// Add profile tokens into the length estimate
	const profileTokens = await api.getProfileTokens();
	conversationData.length += profileTokens;

	const model = pendingRequest?.model || conversationData.model || "Sonnet";
	conversationData.model = model;  // Ensure it's set before forwarding it

	// Update specific tab with conversation metrics
	await updateTabWithConversationData(tabId, conversationData);

	return true;
}


// Listen for message sending
async function onBeforeRequestHandler(details) {
	await Log("Intercepted request:", details.url);
	await Log("Intercepted body:", details.requestBody);
	if (details.method === "POST" &&
		(details.url.includes("/completion") || details.url.includes("/retry_completion"))) {
		await Log("Request sent - URL:", details.url);
		const requestBodyJSON = await parseRequestBody(details.requestBody);
		await Log("Request sent - Body:", requestBodyJSON);
		// Extract IDs from URL - we can refine these regexes
		const urlParts = details.url.split('/');
		const orgId = urlParts[urlParts.indexOf('organizations') + 1];
		await tokenStorageManager.addOrgId(orgId);
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

		let model = "Sonnet"; // Default model
		if (requestBodyJSON?.model) {
			const modelString = requestBodyJSON.model.toLowerCase();
			for (const modelType of CONFIG.MODELS) {
				if (modelString.includes(modelType.toLowerCase())) {
					model = modelType;
					await Log("Model from request:", model);
					break;
				}
			}
		}

		const key = `${orgId}:${conversationId}`;
		await Log(`Message sent - Key: ${key}`);
		const styleId = requestBodyJSON?.personalized_styles?.[0]?.key || requestBodyJSON?.personalized_styles?.[0]?.uuid
		await Log("Choosing style between:", requestBodyJSON?.personalized_styles?.[0]?.key, requestBodyJSON?.personalized_styles?.[0]?.uuid)

		// Process tool definitions if present
		const toolDefs = requestBodyJSON?.tools?.filter(tool =>
			tool.name && !['artifacts_v0', 'repl_v0'].includes(tool.type)
		)?.map(tool => ({
			name: tool.name,
			description: tool.description || '',
			schema: JSON.stringify(tool.input_schema || {})
		})) || [];
		await Log("Tool definitions:", toolDefs);

		// Store pending request with all data
		await pendingRequests.set(key, {
			orgId: orgId,
			conversationId: conversationId,
			tabId: details.tabId,
			styleId: styleId,
			model: model,
			requestTimestamp: Date.now(),
			toolDefinitions: toolDefs
		});
	}

	if (details.method === "GET" && details.url.includes("/settings/billing")) {
		await Log("Hit the billing page, let's make sure we get the updated subscription tier in case it was changed...")
		const orgId = await requestActiveOrgId(details.tabId);
		const api = new ClaudeAPI(details.cookieStoreId, orgId);
		await api.getSubscriptionTier(true);
	}
}

async function onCompletedHandler(details) {
	// Process conversation fetches after a completion. Claude sometimes omits render_all_tools, so only require tree=True.
	if (details.method === "GET" &&
		details.url.includes("/chat_conversations/") &&
		details.url.includes("tree=True")) {

		pendingTasks.push(async () => {
			const urlParts = details.url.split('/');
			const orgId = urlParts[urlParts.indexOf('organizations') + 1];
			await tokenStorageManager.addOrgId(orgId);
			const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]?.split('?')[0];

			const key = `${orgId}:${conversationId}`;
			const result = await processResponse(orgId, conversationId, key, details, details.responseBody);

			if (result && await pendingRequests.has(key)) {
				await pendingRequests.delete(key);
			}
		});

		processNextTask();
	}
}

async function processNextTask() {
	// Check if already processing
	if (processingLock) {
		const lockAge = Date.now() - processingLock;
		if (lockAge < LOCK_TIMEOUT) {
			return;  // Still legitimately processing
		}
		// Lock is stale, force clear it
		await Log("warn", `Stale processing lock detected (${lockAge}ms old), clearing`);
	}

	if (pendingTasks.length === 0) return;

	processingLock = Date.now();
	const task = pendingTasks.shift();

	try {
		await task();
	} catch (error) {
		await Log("error", "Task processing failed:", error);
	} finally {
		// ALWAYS clear the lock, no matter what
		processingLock = null;

		// Process next task if any
		if (pendingTasks.length > 0) {
			processNextTask();  // Not awaited
		}
	}
}
//#endregion

//#region Variable fill in and initialization
pendingRequests = new StoredMap("pendingRequests"); // conversationId -> {userId, tabId}

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
Log("Done initializing.")
//#endregion
