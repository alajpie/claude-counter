/* global config, Log, isMobileView, RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, getNativeUsage, setupTooltip */
'use strict';

// Minimal Chat UI: only token counter + cache timer (m:ss)
class ChatUI {
	constructor() {
		this.lengthDisplay = null;
		this.cachedDisplay = null;
		this.costAndLengthContainer = null;
		this.lengthBar = null;
		this.lastCachedUntilTimestamp = null;
		this.domObserver = null;
		this.reinjectScheduled = false;

		// Native usage summary (session + weekly)
		this.usageLine = null;
		this.sessionUsageSpan = null;
		this.weeklyUsageSpan = null;
		this.sessionBar = null;
		this.sessionBarFill = null;
		this.weeklyBar = null;
		this.weeklyBarFill = null;
		this.sessionResetTimestamp = null;
		this.weeklyResetTimestamp = null;
		this.sessionMarker = null;
		this.weeklyMarker = null;
		this.sessionWindowStartTimestamp = null;
		this.weeklyWindowStartTimestamp = null;
		this.refreshingUsage = false;
	}

	getProgressChrome() {
		const root = document.documentElement;
		const modeDark = root.dataset?.mode === 'dark';
		const modeLight = root.dataset?.mode === 'light';
		const isDark = modeDark && !modeLight;

		return {
			strokeColor: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)',
			markerOutside: isDark ? '#ffffff' : '#111111',
			markerInside: '#ffffff',
			lightShadow: 'none',
		};
	}

	updateMarkerContrast(fillEl, markerEl) {
		if (!fillEl || !markerEl) return;
		const colors = this.getProgressChrome();
		const fillWidth = parseFloat(fillEl.style.width || '0') || 0;
		const markerLeft = parseFloat(markerEl.style.left || '0') || 0;
		const inside = markerLeft <= fillWidth + 0.1; // slight tolerance
		const target = inside ? colors.markerInside : colors.markerOutside;
		if (markerEl.dataset._lastMarkerColor === target) return;
		markerEl.dataset._lastMarkerColor = target;
		markerEl.style.background = target;
		markerEl.style.boxShadow = 'none';
	}

	refreshProgressChrome() {
		const { strokeColor } = this.getProgressChrome();
		if (this.lengthBar) this.lengthBar.style.border = `1px solid ${strokeColor}`;
		if (this.sessionBar) this.sessionBar.style.border = `1px solid ${strokeColor}`;
		if (this.weeklyBar) this.weeklyBar.style.border = `1px solid ${strokeColor}`;
		this.updateMarkerContrast(this.sessionBarFill, this.sessionMarker);
		this.updateMarkerContrast(this.weeklyBarFill, this.weeklyMarker);
	}

	initialize() {
		this.costAndLengthContainer = document.createElement('div');
		this.costAndLengthContainer.className = 'text-text-500 text-xs !px-1 ut-select-none';
		this.costAndLengthContainer.style.marginTop = '2px';

		this.lengthDisplay = document.createElement('span');
		this.cachedDisplay = document.createElement('span');

		this.observeDom();
		this.initUsageLine();

		// Tooltips for header elements
		this.setupHeaderTooltips();
	}

	observeDom() {
		// Watch for our container being removed by SPA re-renders
		this.domObserver = new MutationObserver(() => {
			if (!document.contains(this.costAndLengthContainer) && !this.reinjectScheduled) {
				this.reinjectScheduled = true;
				setTimeout(async () => {
					this.reinjectScheduled = false;
					await this.checkAndReinject();
				}, 50);
			}
		});
		this.domObserver.observe(document.body, { childList: true, subtree: true });
	}

	async checkAndReinject() {
		const chatMenu = document.querySelector(config.SELECTORS.CHAT_MENU);
		if (!chatMenu) return;

		const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
		if (!titleLine) return;

		let header = titleLine;
		while (header && !header.tagName.toLowerCase().includes('header')) {
			header = header.parentElement;
		}

		if (header && header.classList.contains('h-12') && isMobileView()) {
			header.classList.remove('h-12');
		}

		const projectLink = titleLine.querySelector('a[href^="/project/"]');
		if (projectLink) {
			if (!titleLine.querySelector('.chat-project-wrapper')) {
				const wrapper = document.createElement('div');
				wrapper.className = 'chat-project-wrapper flex min-w-0 flex-row items-center md:items-center 2xl:justify-center';

				projectLink.remove();
				wrapper.appendChild(projectLink);

				const chatMenuContainer = chatMenu.closest('.flex.min-w-0.items-center');
				if (chatMenuContainer) {
					chatMenuContainer.remove();
					wrapper.appendChild(chatMenuContainer);
				}

				titleLine.insertBefore(wrapper, titleLine.firstChild);
			}
		}

		titleLine.classList.remove('md:items-center');
		titleLine.classList.add('md:items-start');
		titleLine.classList.remove('md:flex-row');
		titleLine.classList.add('md:flex-col');

		const chatMenuParent = chatMenu.closest('.chat-project-wrapper') || chatMenu.parentElement;
		if (chatMenuParent && chatMenuParent.nextElementSibling !== this.costAndLengthContainer) {
			chatMenuParent.after(this.costAndLengthContainer);
		}

		// Ensure usage line is attached under the model selector
		await this.attachUsageLine();
	}

	async updateConversationDisplay(conversationData) {
		if (!conversationData) return;
		this.updateCostAndLength(conversationData);
	}

	updateCostAndLength(conversationData) {
		if (!conversationData) {
			// No active conversation (e.g. home page) – hide the counter contents
			this.lengthDisplay.innerHTML = '';
			this.cachedDisplay.innerHTML = '';
			this.lengthBar = null;
			this.updateContainer();
			return;
		}

		// Token count with tiny progress bar against a fixed 200k cap
		const TOTAL_TOKEN_CAP = 200000;
		const pct = Math.max(0, Math.min(100, (conversationData.length / TOTAL_TOKEN_CAP) * 100));

		// Clear and rebuild length display
		this.lengthDisplay.innerHTML = '';

		const countSpan = document.createElement('span');
		countSpan.textContent = `~${conversationData.length.toLocaleString()} tokens`;
		this.lengthDisplay.appendChild(countSpan);

		const barContainer = document.createElement('span');
		barContainer.className = 'inline-flex items-center ml-1';
		const bar = document.createElement('div');
		bar.className = 'ut-progress';
		bar.style.width = '60px';
		bar.style.height = '7px';
		bar.style.marginLeft = '0';
		bar.style.position = 'relative';
		bar.style.borderRadius = '2px';
		const { strokeColor } = this.getProgressChrome();
		bar.style.border = `1px solid ${strokeColor}`;
		this.lengthBar = bar;

		const barFill = document.createElement('div');
		barFill.className = 'ut-progress-bar';
		barFill.style.width = `${pct}%`;
		barFill.style.background = BLUE_HIGHLIGHT;

		bar.appendChild(barFill);
		barContainer.appendChild(bar);
		this.lengthDisplay.appendChild(barContainer);
		this.refreshProgressChrome();

		if (conversationData.isCurrentlyCached()) {
			this.lastCachedUntilTimestamp = conversationData.conversationIsCachedUntil;
			const secondsLeft = Math.max(0, Math.ceil((conversationData.conversationIsCachedUntil - Date.now()) / 1000));
			this.cachedDisplay.innerHTML = `Cached for: <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${this.formatSeconds(secondsLeft)}</span>`;
		} else {
			this.lastCachedUntilTimestamp = null;
			this.cachedDisplay.innerHTML = '';
		}

		this.updateContainer();
	}

	setupHeaderTooltips() {
		// Token count tooltip
		const lengthTooltip = document.createElement('div');
		lengthTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		lengthTooltip.textContent = 'Total tokens in this conversation.\nThe small bar shows progress toward 200,000 tokens.\nCounts are approximate and may differ slightly from Claude’s internal billing.';
		document.body.appendChild(lengthTooltip);
		setupTooltip(this.lengthDisplay, lengthTooltip, { topOffset: 8 });

		// Cache timer tooltip
		const cacheTooltip = document.createElement('div');
		cacheTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		cacheTooltip.textContent = 'How long follow-up messages will benefit from Claude’s cache.\nReplies sent before this expires are cheaper than cold messages.';
		document.body.appendChild(cacheTooltip);
		setupTooltip(this.cachedDisplay, cacheTooltip, { topOffset: 8 });
	}

	updateContainer() {
		this.costAndLengthContainer.innerHTML = '';
		const elements = [this.lengthDisplay, this.cachedDisplay].filter(el => el.innerHTML);
		const separator = isMobileView() ? '<br>' : ' | ';

		elements.forEach((element, index) => {
			this.costAndLengthContainer.appendChild(element);
			if (index < elements.length - 1) {
				const sep = document.createElement('span');
				sep.innerHTML = separator;
				// Even horizontal padding around the divider
				sep.style.paddingLeft = '4px';
				sep.style.paddingRight = '4px';
				this.costAndLengthContainer.appendChild(sep);
			}
		});
	}

	updateCachedTime() {
		let cacheExpired = false;
		const now = Date.now();
		this.refreshProgressChrome();

		// Update cache timer if present
		if (this.lastCachedUntilTimestamp && this.cachedDisplay) {
			const diff = this.lastCachedUntilTimestamp - now;
			if (diff <= 0) {
				this.lastCachedUntilTimestamp = null;
				this.cachedDisplay.innerHTML = '';
				this.updateContainer();
				cacheExpired = true;
			} else {
				const timeSpan = this.cachedDisplay.querySelector('.ut-cached-time');
				if (timeSpan) {
					const seconds = Math.ceil(diff / 1000);
					timeSpan.textContent = this.formatSeconds(seconds);
				}
			}
		}

		// Keep usage reset countdowns and time markers up to date even when no cache timer
		const nowForUsage = now;
		let usageExpired = false;
		if (this.sessionResetTimestamp && this.sessionUsageSpan) {
			if (now >= this.sessionResetTimestamp) {
				usageExpired = true;
			} else {
				const text = this.sessionUsageSpan.textContent;
				const idx = text.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = text.slice(0, idx + '· resets in '.length);
					this.sessionUsageSpan.textContent = `${prefix}${this.formatResetCountdown(this.sessionResetTimestamp)}`;
				}
				if (this.sessionMarker && this.sessionWindowStartTimestamp) {
					const total = this.sessionResetTimestamp - this.sessionWindowStartTimestamp;
					const elapsed = Math.max(0, Math.min(total, nowForUsage - this.sessionWindowStartTimestamp));
					const ratio = total > 0 ? elapsed / total : 0;
					this.sessionMarker.style.left = `${Math.max(0, Math.min(100, ratio * 100))}%`;
					this.updateMarkerContrast(this.sessionBarFill, this.sessionMarker);
				}
			}
		}
		if (this.weeklyResetTimestamp && this.weeklyUsageSpan) {
			if (now >= this.weeklyResetTimestamp) {
				usageExpired = true;
			} else {
				const text = this.weeklyUsageSpan.textContent;
				const idx = text.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = text.slice(0, idx + '· resets in '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${this.formatResetCountdown(this.weeklyResetTimestamp)}`;
				}
				if (this.weeklyMarker && this.weeklyWindowStartTimestamp) {
					const total = this.weeklyResetTimestamp - this.weeklyWindowStartTimestamp;
					const elapsed = Math.max(0, Math.min(total, nowForUsage - this.weeklyWindowStartTimestamp));
					const ratio = total > 0 ? elapsed / total : 0;
					this.weeklyMarker.style.left = `${Math.max(0, Math.min(100, ratio * 100))}%`;
					this.updateMarkerContrast(this.weeklyBarFill, this.weeklyMarker);
				}
			}
		}
		// Trigger refresh when session or weekly usage window expires
		if (usageExpired && !this.refreshingUsage) {
			this.refreshingUsage = true;
			this.refreshNativeUsage().finally(() => {
				this.refreshingUsage = false;
			});
		}
		return cacheExpired;
	}

	// ---- Native usage (session + weekly) ----

	initUsageLine() {
		this.usageLine = document.createElement('div');
		this.usageLine.className = 'text-text-400 text-[11px] ut-select-none flex flex-row items-center justify-between gap-3 w-full';

		// Session label + bar
		this.sessionUsageSpan = document.createElement('span');
		this.sessionUsageSpan.style.whiteSpace = 'nowrap';
		this.sessionBar = document.createElement('div');
		this.sessionBar.className = 'ut-progress';
		this.sessionBar.style.flex = '1';
		this.sessionBar.style.height = '10px';
		this.sessionBar.style.position = 'relative';
		const { strokeColor, markerOutside } = this.getProgressChrome();
		this.sessionBar.style.border = `1px solid ${strokeColor}`;
		this.sessionBarFill = document.createElement('div');
		this.sessionBarFill.className = 'ut-progress-bar';
		this.sessionMarker = document.createElement('div');
		this.sessionMarker.style.position = 'absolute';
		this.sessionMarker.style.top = '0';
		this.sessionMarker.style.bottom = '0';
		this.sessionMarker.style.width = '2px';
		this.sessionMarker.style.background = markerOutside;
		this.sessionMarker.style.pointerEvents = 'none';
		this.sessionMarker.style.left = '0%';
		this.sessionBar.appendChild(this.sessionBarFill);
		this.sessionBar.appendChild(this.sessionMarker);

		// Weekly label + bar
		this.weeklyUsageSpan = document.createElement('span');
		this.weeklyUsageSpan.style.whiteSpace = 'nowrap';
		this.weeklyBar = document.createElement('div');
		this.weeklyBar.className = 'ut-progress';
		this.weeklyBar.style.flex = '1';
		this.weeklyBar.style.height = '10px';
		this.weeklyBar.style.position = 'relative';
		this.weeklyBar.style.border = `1px solid ${strokeColor}`;
		this.weeklyBarFill = document.createElement('div');
		this.weeklyBarFill.className = 'ut-progress-bar';
		this.weeklyMarker = document.createElement('div');
		this.weeklyMarker.style.position = 'absolute';
		this.weeklyMarker.style.top = '0';
		this.weeklyMarker.style.bottom = '0';
		this.weeklyMarker.style.width = '2px';
		this.weeklyMarker.style.background = markerOutside;
		this.weeklyMarker.style.pointerEvents = 'none';
		this.weeklyMarker.style.left = '0%';
		this.weeklyBar.appendChild(this.weeklyBarFill);
		this.weeklyBar.appendChild(this.weeklyMarker);

		// Order: session label (left), bars (middle), weekly label (right)
		// Middle container to hold both bars
		const barsContainer = document.createElement('div');
		barsContainer.className = 'flex flex-row items-center gap-2 flex-1';
		barsContainer.appendChild(this.sessionBar);
		barsContainer.appendChild(this.weeklyBar);

		// Order: session label (left), bars (center), weekly label (right)
		this.usageLine.appendChild(this.sessionUsageSpan);
		this.usageLine.appendChild(barsContainer);
		this.usageLine.appendChild(this.weeklyUsageSpan);
		this.refreshProgressChrome();

		// Tooltips for usage labels and bars
		const sessionTooltip = document.createElement('div');
		sessionTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		sessionTooltip.textContent = 'Session usage (≈5 hours).\nBlue bar shows tokens used this session.\nVertical line shows how far through the 5‑hour window you are.';
		document.body.appendChild(sessionTooltip);
		setupTooltip(this.sessionUsageSpan, sessionTooltip, { topOffset: 8 });
		setupTooltip(this.sessionBar, sessionTooltip, { topOffset: 8 });

		const weeklyTooltip = document.createElement('div');
		weeklyTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		weeklyTooltip.textContent = 'Weekly usage (all models).\nBlue bar shows weekly tokens used.\nVertical line shows progress through the 7‑day period.';
		document.body.appendChild(weeklyTooltip);
		setupTooltip(this.weeklyUsageSpan, weeklyTooltip, { topOffset: 8 });
		setupTooltip(this.weeklyBar, weeklyTooltip, { topOffset: 8 });

		// Clicking anywhere on the usage line triggers a manual refresh with a small visual hint
		this.usageLine.style.cursor = 'pointer';
		this.usageLine.addEventListener('click', async () => {
			if (this.refreshingUsage) return;
			this.refreshingUsage = true;
			const prevOpacity = this.usageLine.style.opacity;
			this.usageLine.style.opacity = '0.6';
			try {
				await this.refreshNativeUsage();
			} finally {
				this.usageLine.style.opacity = prevOpacity || '';
				this.refreshingUsage = false;
			}
		});

		// Fire and forget initial fetch; errors are logged but ignored
		this.refreshNativeUsage().catch(() => {});
	}

	async attachUsageLine() {
		if (!this.usageLine) return;
		const selector = config.SELECTORS.MODEL_SELECTOR || config.SELECTORS.MODEL_PICKER;
		if (!selector) return;

		const modelSelector = document.querySelector(selector);
		if (!modelSelector) return;

		const selectorLine = modelSelector.parentElement?.parentElement;
		if (!selectorLine) return;

		if (selectorLine.nextElementSibling !== this.usageLine) {
			selectorLine.after(this.usageLine);
		}
	}

	async refreshNativeUsage() {
		this.refreshProgressChrome();
		let usage;
		try {
			usage = await getNativeUsage();
		} catch (e) {
			await Log("error", "Failed to fetch native usage:", e);
			return;
		}

		if (!usage) return;

		const session = usage.five_hour || null;
		const weekly = usage.seven_day || null;

		// Session line
		if (session && typeof session.utilization === 'number') {
			const pct = Math.round(session.utilization);
			this.sessionResetTimestamp = session.resets_at ? Date.parse(session.resets_at) : null;
			this.sessionWindowStartTimestamp = this.sessionResetTimestamp
				? this.sessionResetTimestamp - 5 * 60 * 60 * 1000
				: null;
			const timeStr = this.sessionResetTimestamp ? this.formatResetCountdown(this.sessionResetTimestamp) : 'N/A';
			this.sessionUsageSpan.textContent = `Session: ${pct}% · resets in ${timeStr}`;
			if (this.sessionBarFill) {
				const width = Math.max(0, Math.min(100, pct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.style.background = width >= 90 ? RED_WARNING : BLUE_HIGHLIGHT;
			}
			if (this.sessionMarker && this.sessionWindowStartTimestamp && this.sessionResetTimestamp) {
				const now = Date.now();
				const total = this.sessionResetTimestamp - this.sessionWindowStartTimestamp;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartTimestamp));
				const ratio = total > 0 ? elapsed / total : 0;
				this.sessionMarker.style.left = `${Math.max(0, Math.min(100, ratio * 100))}%`;
			}
			this.updateMarkerContrast(this.sessionBarFill, this.sessionMarker);
		} else {
			this.sessionUsageSpan.textContent = '';
			if (this.sessionBarFill) {
				this.sessionBarFill.style.width = '0%';
			}
			this.sessionResetTimestamp = null;
			this.sessionWindowStartTimestamp = null;
		}

		// Weekly line
		if (weekly && typeof weekly.utilization === 'number') {
			const pct = Math.round(weekly.utilization);
			this.weeklyResetTimestamp = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
			this.weeklyWindowStartTimestamp = this.weeklyResetTimestamp
				? this.weeklyResetTimestamp - 7 * 24 * 60 * 60 * 1000
				: null;
			const timeStr = this.weeklyResetTimestamp ? this.formatResetCountdown(this.weeklyResetTimestamp) : 'N/A';
			this.weeklyUsageSpan.textContent = `Weekly: ${pct}% · resets in ${timeStr}`;
			if (this.weeklyBarFill) {
				const width = Math.max(0, Math.min(100, pct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.style.background = width >= 90 ? RED_WARNING : BLUE_HIGHLIGHT;
			}
			if (this.weeklyMarker && this.weeklyWindowStartTimestamp && this.weeklyResetTimestamp) {
				const now = Date.now();
				const total = this.weeklyResetTimestamp - this.weeklyWindowStartTimestamp;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartTimestamp));
				const ratio = total > 0 ? elapsed / total : 0;
				this.weeklyMarker.style.left = `${Math.max(0, Math.min(100, ratio * 100))}%`;
			}
			this.updateMarkerContrast(this.weeklyBarFill, this.weeklyMarker);
		} else {
			this.weeklyUsageSpan.textContent = '';
			if (this.weeklyBarFill) {
				this.weeklyBarFill.style.width = '0%';
			}
			this.weeklyResetTimestamp = null;
			this.weeklyWindowStartTimestamp = null;
		}
	}

	formatResetCountdown(timestamp) {
		const now = Date.now();
		const diffMs = timestamp - now;
		if (diffMs <= 0) return '0m';

		const totalMinutes = Math.round(diffMs / (1000 * 60));
		if (totalMinutes < 60) {
			return `${totalMinutes}m`;
		}
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) {
			return `${hours}h ${minutes}m`;
		}
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		const paddedSeconds = seconds.toString().padStart(2, '0');
		return `${minutes}:${paddedSeconds}`;
	}
}
