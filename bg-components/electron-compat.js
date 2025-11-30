import '../lib/browser-polyfill.min.js';
import { CONFIG, isElectron, sleep, RawLog, FORCE_DEBUG, containerFetch, addContainerFetchListener, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, messageRegistry } from './utils.js';

async function Log(...args) {
	await RawLog("electron-compat", ...args)
};

const electronAlarms = new StoredMap('electronAlarms');

export async function clearAlarm(name) {
	if (!isElectron) {
		return browser.alarms.clear(name);
	} else {
		// Clear from persistent storage
		await electronAlarms.delete(name);

		// Tell Node to clear it
		const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
		if (tabs.length > 0) {
			await chrome.scripting.executeScript({
				target: { tabId: tabs[0].id },
				func: (data) => {
					console.log('CUT_ALARM:' + JSON.stringify(data));
				},
				args: [{
					action: 'clear',
					name: name
				}]
			});
		}
	}
}

export async function getAlarm(name) {
	if (!isElectron) {
		return browser.alarms.get(name);
	} else {
		// Return from persistent storage
		return await electronAlarms.get(name);
	}
}

export async function scheduleAlarm(name, options) {
	if (!isElectron) {
		browser.alarms.create(name, options);
	} else {
		// Electron - pass full options
		const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
		if (tabs.length > 0) {
			await chrome.scripting.executeScript({
				target: { tabId: tabs[0].id },
				func: (data) => {
					console.log('CUT_ALARM:' + JSON.stringify(data));
				},
				args: [{
					action: 'create',
					name: name,
					...options  // Spread all options (when, periodInMinutes, delayInMinutes)
				}]
			});
		}
	}
}
