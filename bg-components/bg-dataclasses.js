import { CONFIG } from './utils.js';

export class ConversationData {
	constructor(data = {}) {
		this.conversationId = data.conversationId;
		this.messages = data.messages || [];

		// Calculated metrics
		this.length = data.length || 0;  // Total tokens in conversation
		this.model = data.model || 'Sonnet';

		// Cache status
		this.conversationIsCachedUntil = data.conversationIsCachedUntil || null;

		// Associated metadata
		this.projectUuid = data.projectUuid || null;
		this.styleId = data.styleId || null;
		this.settings = data.settings || {};
		this.lastMessageTimestamp = data.lastMessageTimestamp || null; // Timestamp of the last message in the conversation
	}

	// Add helper method to check if currently cached
	isCurrentlyCached() {
		return this.conversationIsCachedUntil && this.conversationIsCachedUntil > Date.now();
	}

	// Add method to get time until cache expires
	getTimeUntilCacheExpires() {
		if (!this.conversationIsCachedUntil) return null;

		const now = Date.now();
		const diff = this.conversationIsCachedUntil - now;

		if (diff <= 0) return { expired: true, minutes: 0 };

		return {
			expired: false,
			minutes: Math.ceil(diff / (1000 * 60))  // Round up to nearest minute
		};
	}


	// Check if conversation is long
	isLong() {
		return this.length >= CONFIG.WARNING.LENGTH;
	}

	toJSON() {
		return {
			conversationId: this.conversationId,
			messages: this.messages,
			length: this.length,
			model: this.model,
			conversationIsCachedUntil: this.conversationIsCachedUntil,
			projectUuid: this.projectUuid,
			styleId: this.styleId,
			settings: this.settings,
			lastMessageTimestamp: this.lastMessageTimestamp
		};
	}

	static fromJSON(json) {
		return new ConversationData(json);
	}
}
