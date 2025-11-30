/* global ConversationData, ChatUI, sendBackgroundMessage, config:writable, getConversationId, Log, ui:writable, waitForElement, sleep, setupRateLimitMonitoring, observeUrlChanges */
'use strict';

// Main UI Manager
class UIManager {
	constructor() {
		this.chatUI = new ChatUI();
		this.conversationData = null;
		this.cacheCountdownInterval = null;
		this.uiReinjectInterval = null;
	}

	async initialize() {
		this.chatUI.initialize();

		// Initial update for the current URL/conversation (if any)
		await this.handleUrlChange();

		// Org init - just request, don't await response
		await sendBackgroundMessage({ type: 'initOrg' });

		// Set up event-driven URL observer for conversation changes
		observeUrlChanges(() => this.handleUrlChange());

		this.startIntervals();

	}

	startIntervals() {
		if (!this.cacheCountdownInterval) {
			this.cacheCountdownInterval = setInterval(() => this.updateCacheCountdown(), 1000);
		}
		if (!this.uiReinjectInterval) {
			this.uiReinjectInterval = setInterval(() => this.checkUiReinject(), 2000);
		}
	}

	stopIntervals() {
		if (this.cacheCountdownInterval) {
			clearInterval(this.cacheCountdownInterval);
			this.cacheCountdownInterval = null;
		}
		if (this.uiReinjectInterval) {
			clearInterval(this.uiReinjectInterval);
			this.uiReinjectInterval = null;
		}
	}

	restartIntervals() {
		this.stopIntervals();
		this.startIntervals();
	}

	async handleUrlChange() {
		const newConversation = getConversationId();
		const isHomePage = newConversation === null;

		if (this.conversationData?.conversationId !== newConversation && !isHomePage) {
			// Just request, don't await response
			await Log("Conversation changed, requesting data for new conversation.");
			sendBackgroundMessage({
				type: 'requestData',
				conversationId: newConversation
			});
			if (this.conversationData) {
				this.conversationData.conversationId = newConversation;
			} else {
				this.conversationData = new ConversationData({ conversationId: newConversation });
			}
		}

		// Update home page state if needed
		if (isHomePage && this.conversationData !== null) {
			this.conversationData = null;
			this.chatUI.updateCostAndLength();
		}
	}

	async updateCacheCountdown() {
		const cacheExpired = this.chatUI.updateCachedTime();
		if (cacheExpired) {
			const currConversation = getConversationId();
			if (currConversation) {
				// Cache expired - request fresh data to update costs
				await Log("Cache expired, requesting data");
				sendBackgroundMessage({
					type: 'requestData',
					conversationId: currConversation
				});
			}
		}
	}

	async checkUiReinject() {
		await this.chatUI.checkAndReinject();
	}

	async updateConversation(conversationData) {
		await Log("Updating conversation data", {
			conversationId: conversationData.conversationId,
			length: conversationData.length
		});
		if (!conversationData) return;

		this.conversationData = ConversationData.fromJSON(conversationData);

		// Update chat UI immediately - no waiting for polling cycles
		if (this.chatUI && this.conversationData) {
			await Log("Updating conversation data:", this.conversationData);
			await this.chatUI.updateConversationDisplay(this.conversationData);
			// Refresh native usage bars after each conversation update
			if (typeof this.chatUI.refreshNativeUsage === 'function') {
				this.chatUI.refreshNativeUsage().catch(() => { });
			}
		}
	}
}

// Event Handlers
// Listen for messages from background
browser.runtime.onMessage.addListener(async (message) => {
	await Log("Content received message:", message.type);
	if (message.type === 'updateConversationData') {
		if (ui) await ui.updateConversation(message.data.conversationData);
	}

	if (message.action === "getOrgID") {
		const orgId = document.cookie
			.split('; ')
			.find(row => row.startsWith('lastActiveOrg='))
			?.split('=')[1];
		return Promise.resolve({ orgId });
	}

	if (message.action === "getStyleId") {
		const storedStyle = localStorage.getItem('LSS-claude_personalized_style');
		let styleId;

		if (storedStyle) {
			try {
				const styleData = JSON.parse(storedStyle);
				if (styleData) styleId = styleData.styleKey;
			} catch (e) {
				// If JSON parsing fails, we'll return undefined
				await Log("error", 'Failed to parse stored style:', e);
			}
		}

		return Promise.resolve({ styleId });
	}
});

// Style injection
async function injectStyles() {
	if (document.getElementById('ut-styles')) return;

	try {
		const cssContent = await fetch(browser.runtime.getURL('tracker-styles.css')).then(r => r.text());

		// Just change these lines:
		const style = document.createElement('link');
		style.rel = 'stylesheet';
		style.id = 'ut-styles';
		style.href = `data:text/css;charset=utf-8,${encodeURIComponent(cssContent)}`;

		document.head.appendChild(style);
	} catch (error) {
		await Log("error", 'Failed to load tracker styles:', error);
	}
}

// Main initialization function
async function initExtension() {
	if (window.claudeTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;
	const LOGIN_CHECK_DELAY = 10000;
	await injectStyles();
	// Load and assign configuration to global variables
	config = await sendBackgroundMessage({ type: 'getConfig' });
	await Log("Config received...")
	await Log(config)
	let userMenuButton = null;
	while (true) {
		// Check for duplicate running with retry logic

		userMenuButton = await waitForElement(document, config.SELECTORS.USER_MENU_BUTTON, 6000);
		if (userMenuButton) {
			// Found the button, continue with initialization
			break;
		}

		// Check if we're on either login screen
		const initialLoginScreen = document.querySelector(config.SELECTORS.INIT_LOGIN_SCREEN);
		const verificationLoginScreen = document.querySelector(config.SELECTORS.VERIF_LOGIN_SCREEN);

		if (!initialLoginScreen && !verificationLoginScreen) {
			await Log("error", 'Neither user menu button nor any login screen found');
			return;
		}

		await Log('Login screen detected, waiting before retry...');
		await sleep(LOGIN_CHECK_DELAY);
	}

	if (userMenuButton.getAttribute('data-script-loaded')) {
		await Log('Script already running, stopping duplicate');
		return;
	}
	userMenuButton.setAttribute('data-script-loaded', true);
	await Log('We\'re unique, initializing Claude Counter...');

	await Log("Initializing fetch...")
	await setupRateLimitMonitoring();

	// Set up fetch monkeypatch to intercept conversation data
	const patterns = await sendBackgroundMessage({ type: 'getMonkeypatchPatterns' });
	if (patterns) {
		await setupRequestInterception(patterns);
	}

	ui = new UIManager();
	await ui.initialize();

	// Don't await responses anymore
	sendBackgroundMessage({ type: 'requestData' });
	sendBackgroundMessage({ type: 'initOrg' });
	await Log('Initialization complete. Ready to track tokens.');
}

(async () => {
	try {
		await initExtension();
	} catch (error) {
	await Log("error", 'Failed to initialize Claude Counter:', error);
	}
})();
