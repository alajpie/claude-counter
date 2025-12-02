'use strict';

// Constants
const BLUE_HIGHLIGHT = "#2c84db";
const RED_WARNING = "#de2929";
const SUCCESS_GREEN = "#22c55e";
// Dynamic debug setting - will be loaded from storage
let FORCE_DEBUG = false;
// Load FORCE_DEBUG from storage and set up error handlers
browser.storage.local.get('force_debug').then(result => {
	FORCE_DEBUG = result.force_debug || false;

	// Set up error logging based on debug setting
	if (!FORCE_DEBUG) {
		window.addEventListener('error', async function (event) {
			await logError(event.error);

		});

		window.addEventListener('unhandledrejection', async function (event) {
			await logError(event.reason);

		});

		self.onerror = async function (message, source, lineno, colno, error) {
			await logError(error);
			return false;
		};
	}
});

// Notify background that this tab has a content script ready
browser.runtime.sendMessage({ type: 'tabReady' }).catch(() => {});

// Global variables that will be shared across all content scripts
let config;
let ui;

// Logging function
async function Log(...args) {
	const sender = `content:${document.title.substring(0, 20)}${document.title.length > 20 ? '...' : ''}`;
	let level = "debug";

	// If first argument is a valid log level, use it and remove it from args
	if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
		level = args.shift();
	}

	const result = await browser.storage.local.get('debug_mode_until');
	const debugUntil = result.debug_mode_until;
	const now = Date.now();

	if ((!debugUntil || debugUntil <= now) && !FORCE_DEBUG) {
		return;
	}

	if (level === "debug") {
		console.log("[ClaudeCounter]", ...args);
	} else if (level === "warn") {
		console.warn("[ClaudeCounter]", ...args);
	} else if (level === "error") {
		console.error("[ClaudeCounter]", ...args);
	} else {
		console.log("[ClaudeCounter]", ...args);
	}

	const timestamp = new Date().toLocaleString('default', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		fractionalSecondDigits: 3
	});

	const logEntry = {
		timestamp: timestamp,
		sender: sender,
		level: level,
		message: args.map(arg => {
			if (arg instanceof Error) {
				return arg.stack || `${arg.name}: ${arg.message}`;
			}
			if (typeof arg === 'object') {
				// Handle null case
				if (arg === null) return 'null';
				// For other objects, try to stringify with error handling
				try {
					return JSON.stringify(arg, Object.getOwnPropertyNames(arg), 2);
				} catch (e) {
					return String(arg);
				}
			}
			return String(arg);
		}).join(' ')
	};

	const logsResult = await browser.storage.local.get('debug_logs');
	const logs = logsResult.debug_logs || [];
	logs.push(logEntry);

	if (logs.length > 1000) logs.shift();

	await browser.storage.local.set({ debug_logs: logs });
}

async function logError(error) {
	// Ignore null/undefined errors
	if (error == null) return;

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

// Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getConversationId() {
	const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
	return match ? match[1] : null;
}

function observeUrlChanges(callback) {
	let lastUrl = window.location.pathname;

	const fireIfChanged = () => {
		const current = window.location.pathname;
		if (current !== lastUrl) {
			lastUrl = current;
			callback();
		}
	};

	const origPushState = history.pushState.bind(history);
	const origReplaceState = history.replaceState.bind(history);

	history.pushState = function (...args) {
		const result = origPushState(...args);
		fireIfChanged();
		return result;
	};

	history.replaceState = function (...args) {
		const result = origReplaceState(...args);
		fireIfChanged();
		return result;
	};

	// Handle browser back/forward
	window.addEventListener('popstate', fireIfChanged);
}

async function getNativeUsage() {
	return await sendBackgroundMessage({ type: 'getNativeUsage' });
}

async function sendBackgroundMessage(message) {
	const enrichedMessage = {
		...message,
		orgId: document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1]
	};
	let counter = 10;
	while (counter > 0) {
		try {
			const response = await browser.runtime.sendMessage(enrichedMessage);
			return response;
		} catch (error) {
			// Check if it's the specific "receiving end does not exist" error
			if (error.message?.includes('Receiving end does not exist')) {
				await Log("warn", 'Background script not ready, retrying...', error);
				await sleep(200);
			} else {
				// For any other error, throw immediately
				throw error;
			}
		}
		counter--;
	}
	throw new Error("Failed to send message to background script after 10 retries.");
}

async function waitForElement(target, selector, maxTime = 1000) {
	let elapsed = 0;
	const waitInterval = 100
	while (elapsed < maxTime) {
		const element = target.querySelector(selector);
		if (element) return element;
		await sleep(waitInterval);
		elapsed += waitInterval;
	}

	return null;
}

function isMobileView() {
	// Check if height > width (portrait orientation)
	return window.innerHeight > window.innerWidth;
}

async function setupRateLimitMonitoring() {
	// Set up rate limit event listener
	window.addEventListener('rateLimitExceeded', async (event) => {
		await Log("Rate limit exceeded", event.detail);
	});

	// Inject external rate limit monitoring script
	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/rate-limit-watcher.js');
	script.onload = function () {
		this.remove();
	};
	(document.head || document.documentElement).appendChild(script);

	// Allow setting API key from page console via postMessage
	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		if (event.data?.type === 'claudeCounterSetApiKey' && typeof event.data.key === 'string') {
			await browser.storage.local.set({ apiKey: event.data.key });
			console.log('[ClaudeCounter] API key saved');
		}
	});
}

async function setupRequestInterception(patterns) {
	// Set up event listeners in content script context
	window.addEventListener('interceptedRequest', async (event) => {
		await Log("Intercepted request", event.detail);
		browser.runtime.sendMessage({
			type: 'interceptedRequest',
			details: event.detail
		});
	});

	window.addEventListener('interceptedResponse', async (event) => {
		await Log("Intercepted response", event.detail);
		browser.runtime.sendMessage({
			type: 'interceptedResponse',
			details: event.detail
		});
	});

	// Inject external request interception script with patterns as data attribute
	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/webrequest-polyfill.js');
	script.dataset.patterns = JSON.stringify(patterns);
	script.onload = function () {
		this.remove();
	};
	(document.head || document.documentElement).appendChild(script);
}

function setupTooltip(element, tooltip, options = {}) {
	if (!element || !tooltip) return;

	// Check if already set up
	if (element.hasAttribute('data-tooltip-setup')) {
		return;
	}
	element.setAttribute('data-tooltip-setup', 'true');

	const { topOffset = 10 } = options;

	// Add standard classes for all tooltip elements
	element.classList.add('ut-tooltip-trigger', 'ut-info-item');
	element.style.cursor = 'help';


	let pressTimer;
	let tooltipHideTimer;

	const showTooltip = () => {
		const rect = element.getBoundingClientRect();
		tooltip.style.opacity = '1';
		const tooltipRect = tooltip.getBoundingClientRect();

		let leftPos = rect.left + (rect.width / 2);
		if (leftPos + (tooltipRect.width / 2) > window.innerWidth) {
			leftPos = window.innerWidth - tooltipRect.width - 10;
		}
		if (leftPos - (tooltipRect.width / 2) < 0) {
			leftPos = tooltipRect.width / 2 + 10;
		}

		let topPos = rect.top - tooltipRect.height - topOffset;
		if (topPos < 10) {
			topPos = rect.bottom + 10;
		}

		tooltip.style.left = `${leftPos}px`;
		tooltip.style.top = `${topPos}px`;
		tooltip.style.transform = 'translateX(-50%)';
	};

	const hideTooltip = () => {
		tooltip.style.opacity = '0';
		clearTimeout(tooltipHideTimer);
	};

	// Pointer events work for both mouse and touch
	element.addEventListener('pointerdown', (e) => {

		if (e.pointerType === 'touch' || isMobileView()) {
			// Touch/mobile: long press
			pressTimer = setTimeout(() => {
				showTooltip();

				// Auto-hide after 3 seconds
				tooltipHideTimer = setTimeout(hideTooltip, 3000);
			}, 500);
		}
		// Mouse is handled by enter/leave below
	});

	element.addEventListener('pointerup', (e) => {
		if (e.pointerType === 'touch' || isMobileView()) {
			clearTimeout(pressTimer);
		}
	});

	element.addEventListener('pointercancel', (e) => {
		clearTimeout(pressTimer);
		hideTooltip();
	});

	// Keep mouse hover for desktop
	if (!isMobileView()) {
		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') {
				showTooltip();
			}
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') {
				hideTooltip();
			}
		});
	}
}
