import {ensureTenant, authorizePlugins, getGmailOAuthUrl, getCalendarOAuthUrl, getConnectedPlugins, getConnectedAccounts, getAccountsExist, storeGmailConnectedEmail, storeCalendarConnectedEmail, clearConnectionEmail, processOAuthCallbackForPlugin } from "@repo/services/tenant/index.js";
import { getThreads, getThread, sendEmail, searchEmails, syncEmails, getStoredEmailCount, searchLocalEmails, generateMissingEmbeddings, getPendingEmbeddingsCount } from "@repo/services/gmail/index.js";
import { getEvents, getEvent, createEvent, updateEvent, deleteEvent, respondToEvent, CalendarEventGoneError } from "@repo/services/calendar/index.js";
import { linkThreadEvent, closeThreadLink, acknowledgeThreadLink, getActiveThreadMeetings, resolveThreadMeetings, getUnacknowledgedDeletion, getEventWriteRole } from "@repo/services/calendar/thread-links.js";
import { listConversations, getMessages, deleteConversation } from "@repo/services/assistant/index.js";
import { getCategories, createCategory, deleteCategory, getTemplates, getTemplateCount, createTemplate, updateTemplate, deleteTemplate, MailTemplateError, MAX_TEMPLATES_PER_USER } from "@repo/services/mail-templates/index.js";
import type { CategoryRow, TemplateRow } from "@repo/services/mail-templates/index.js";

export { ensureTenant, authorizePlugins, getGmailOAuthUrl, getCalendarOAuthUrl, getConnectedPlugins, getConnectedAccounts, getAccountsExist, storeGmailConnectedEmail, storeCalendarConnectedEmail, clearConnectionEmail, processOAuthCallbackForPlugin };
export { getThreads, getThread, sendEmail, searchEmails, syncEmails, getStoredEmailCount, searchLocalEmails, generateMissingEmbeddings, getPendingEmbeddingsCount };
export { getEvents, getEvent, createEvent, updateEvent, deleteEvent, respondToEvent, CalendarEventGoneError };
export { linkThreadEvent, closeThreadLink, acknowledgeThreadLink, getActiveThreadMeetings, resolveThreadMeetings, getUnacknowledgedDeletion, getEventWriteRole };
export { listConversations, getMessages, deleteConversation };
export { getCategories, createCategory, deleteCategory, getTemplates, getTemplateCount, createTemplate, updateTemplate, deleteTemplate, MailTemplateError, MAX_TEMPLATES_PER_USER };
export type { CategoryRow, TemplateRow };