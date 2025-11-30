// debug.js
let autoRefreshInterval;
const PERMANENT_DEBUG = 8640000000000000; // Maximum safe timestamp in JavaScript

document.getElementById('refresh').addEventListener('click', showLogs);
document.getElementById('clear').addEventListener('click', clearLogs);
document.getElementById('enableDebug').addEventListener('click', toggleDebugMode);
document.getElementById('enablePermanentDebug').addEventListener('click', enablePermanentDebug);
document.getElementById('saveApiKey').addEventListener('click', saveApiKey);
document.getElementById('clearApiKey').addEventListener('click', clearApiKey);

function showLogs() {
	browser.storage.local.get('debug_logs')
		.then(result => {
			const logs = result.debug_logs || [];
			const preElement = document.getElementById('logs');

			preElement.innerHTML = '';

			logs.forEach(log => {
				const logLine = document.createElement('div');
				logLine.className = 'log-line';
				logLine.dataset.level = log.level || 'debug'; // Add level to the log line

				const timestamp = document.createElement('span');
				timestamp.className = 'log-timestamp';
				timestamp.textContent = log.timestamp;

				const sender = document.createElement('span');
				sender.className = 'log-sender';
				sender.dataset.sender = log.sender;
				sender.textContent = log.sender;

				const message = document.createElement('span');
				message.className = 'log-message';
				message.textContent = log.message;

				logLine.appendChild(timestamp);
				logLine.appendChild(sender);
				logLine.appendChild(message);
				preElement.appendChild(logLine);
			});

			scrollToBottom();
		});
}

function scrollToBottom() {
	const preElement = document.getElementById('logs');
	preElement.scrollTop = preElement.scrollHeight;
}

function clearLogs() {
	browser.storage.local.set({ debug_logs: [] })
		.then(showLogs);
}

function updateDebugStatus() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;
			const isPermanent = debugUntil === PERMANENT_DEBUG;
			const timeLeft = isEnabled && !isPermanent ? Math.ceil((debugUntil - now) / 60000) : 0;

			// Update status text
			const statusElement = document.getElementById('debugStatus');
			statusElement.textContent = isPermanent
				? 'Debug mode enabled (permanent)'
				: isEnabled
					? `Debug mode enabled (${timeLeft} minutes remaining)`
					: 'Debug mode disabled';

			// Update buttons visibility and text
			const debugButton = document.getElementById('enableDebug');
			const permanentDebugButton = document.getElementById('enablePermanentDebug');

			if (isEnabled) {
				debugButton.textContent = 'Disable Debug Mode';
				permanentDebugButton.style.display = 'none';
			} else {
				debugButton.textContent = 'Enable Debug Mode (1 hour)';
				permanentDebugButton.style.display = 'inline-block';
			}

			if (!isEnabled && autoRefreshInterval) {
				stopAutoRefresh();
			} else if (isEnabled && !autoRefreshInterval) {
				startAutoRefresh();
			}
		});
}

function toggleDebugMode() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;

			if (isEnabled) {
				// Disable debug mode by setting timestamp to now (expired)
				return browser.storage.local.set({ debug_mode_until: now });
			} else {
				// Enable debug mode for 1 hour
				const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).getTime();
				return browser.storage.local.set({ debug_mode_until: oneHourFromNow });
			}
		})
		.then(() => {
			updateDebugStatus();
		});
}

function enablePermanentDebug() {
	browser.storage.local.set({ debug_mode_until: PERMANENT_DEBUG })
		.then(() => {
			updateDebugStatus();
		});
}

function startAutoRefresh() {
	if (!autoRefreshInterval) {
		autoRefreshInterval = setInterval(() => {
			if (document.getElementById('autoUpdate').checked) {
				showLogs();
			}
			updateDebugStatus();
		}, 5000);
	}
}

function stopAutoRefresh() {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval);
		autoRefreshInterval = null;
	}
}

function refreshApiKeyStatus() {
	const statusElement = document.getElementById('apiKeyStatus');
	const input = document.getElementById('apiKeyInput');

	browser.runtime.sendMessage({ type: 'getAPIKey' })
		.then((apiKey) => {
			if (apiKey) {
				input.value = apiKey;
				statusElement.textContent = 'API key is set (stored locally).';
			} else {
				input.value = '';
				statusElement.textContent = 'API key not set.';
			}
		})
		.catch(() => {
			statusElement.textContent = 'Unable to read API key.';
		});
}

function saveApiKey() {
	const input = document.getElementById('apiKeyInput');
	const statusElement = document.getElementById('apiKeyStatus');
	const newKey = input.value.trim();

	browser.runtime.sendMessage({ type: 'setAPIKey', newKey })
		.then((result) => {
			if (newKey === '') {
				statusElement.textContent = 'API key cleared.';
			} else if (result) {
				statusElement.textContent = 'API key saved and validated.';
			} else {
				statusElement.textContent = 'API key validation failed.';
			}
		})
		.catch(() => {
			statusElement.textContent = 'Error saving API key.';
		});
}

function clearApiKey() {
	const input = document.getElementById('apiKeyInput');
	input.value = '';
	saveApiKey();
}

// Initial setup
showLogs();
updateDebugStatus();
startAutoRefresh();
refreshApiKeyStatus();

if (!chrome.tabs?.create) {
	const returnButton = document.getElementById('returnToClaude');
	returnButton.style.display = 'inline-block';
	returnButton.addEventListener('click', () => {
		window.location.href = 'https://claude.ai';
	});
}

// Clean up when the page is closed
window.addEventListener('beforeunload', stopAutoRefresh);
