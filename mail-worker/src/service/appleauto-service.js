const DEFAULT_APPLE_DOMAINS = [
	'apple.com',
	'email.apple.com',
	'id.apple.com',
	'icloud.com'
];

function getDomain(address = '') {
	const parts = String(address).toLowerCase().split('@');
	return parts.length > 1 ? parts.pop() : '';
}

function getHeader(parsedEmail, name) {
	const headers = parsedEmail?.headers;
	const lowerName = String(name).toLowerCase();

	if (!headers) {
		return '';
	}

	if (typeof headers.get === 'function') {
		return headers.get(name) || headers.get(lowerName) || '';
	}

	if (Array.isArray(headers)) {
		const item = headers.find(h => {
			const key = String(h.key || h.name || '').toLowerCase();
			return key === lowerName;
		});

		return item?.value || '';
	}

	if (typeof headers === 'object') {
		return headers[name] || headers[lowerName] || '';
	}

	return '';
}

function formatAddress(addressObj, fallback = '') {
	if (!addressObj) {
		return fallback || '';
	}

	const address = addressObj.address || fallback || '';
	const name = addressObj.name || '';

	if (!address) {
		return '';
	}

	if (name) {
		return `${name} <${address}>`;
	}

	return address;
}

function getRawSize(raw = '') {
	try {
		return new TextEncoder().encode(raw).length;
	} catch (e) {
		return String(raw || '').length;
	}
}

function base64EncodeUtf8(str = '') {
	const bytes = new TextEncoder().encode(str);
	let binary = '';
	const chunkSize = 0x8000;

	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

async function sha256Hex(text = '') {
	const data = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));

	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function stripHtml(html = '') {
	return String(html)
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
			try {
				return String.fromCharCode(parseInt(hex, 16));
			} catch (e) {
				return ' ';
			}
		})
		.replace(/&#(\d+);/g, (_, num) => {
			try {
				return String.fromCharCode(parseInt(num, 10));
			} catch (e) {
				return ' ';
			}
		})
		.replace(/\s+/g, ' ')
		.trim();
}

function extractAppleRestoreLink(text = '') {
	const urls = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];

	return urls.find(url => {
		return /apple|icloud|iforgot|account|appleid|idmsa|support/i.test(url);
	}) || '';
}

function getNormalizedMailText(parsedEmail, raw = '') {
	const subject = parsedEmail?.subject || '';
	const text = parsedEmail?.text || '';
	const htmlText = stripHtml(parsedEmail?.html || '');

	return `${subject}\n${text}\n${htmlText}\n${raw || ''}`;
}

function isAppleMail(parsedEmail, message) {
	const from = parsedEmail?.from?.address || message?.from || '';
	const domain = getDomain(from);
	const subject = parsedEmail?.subject || '';
	const text = parsedEmail?.text || '';
	const html = parsedEmail?.html || '';

	const domainOk = DEFAULT_APPLE_DOMAINS.some(d => {
		return domain === d || domain.endsWith(`.${d}`);
	});

	if (!domainOk) {
		return false;
	}

	const fullText = `${subject}\n${text}\n${html}`;

	// 只处理真正可用于恢复/解除双重认证的 Apple 邮件
	const hasRestoreLinkText =
		/回復先前的保安設定|恢復先前的保安設定|恢复先前的安全设置|恢复先前的保安设置|restore previous security settings|return to your previous security settings/i.test(fullText);

	const twoFactorEnabled =
		/(雙重認證|双重认证|雙重驗證|双重验证|two-factor authentication|two factor authentication|two-step verification).{0,160}(啟用|启用|已於|已于|已在|enabled|turned on)/i.test(fullText) ||
		/(啟用|启用|已於|已于|已在|enabled|turned on).{0,160}(雙重認證|双重认证|雙重驗證|双重验证|two-factor authentication|two factor authentication|two-step verification)/i.test(fullText);

	return hasRestoreLinkText || twoFactorEnabled;
}

async function shouldSkipDuplicate({ env, parsedEmail, raw }) {
	if (!env.kv || typeof env.kv.get !== 'function' || typeof env.kv.put !== 'function') {
		console.log('[AppleAutoPro] KV not available, skip dedupe.');
		return false;
	}

	const subject = parsedEmail?.subject || '';
	const text = parsedEmail?.text || '';
	const htmlText = stripHtml(parsedEmail?.html || '');
	const fullText = getNormalizedMailText(parsedEmail, raw);

	const restoreLink = extractAppleRestoreLink(fullText);

	// 优先用 Apple 恢复链接去重。
	// 如果没提取到链接，就用主题 + 正文摘要去重。
	// 注意：不要加入收件人 rcpt_to，否则 Apple ID 邮箱和救援邮箱各收到一封时就无法去重。
	const dedupeSource = restoreLink || `${subject}\n${text}\n${htmlText}`.slice(0, 5000);
	const hash = await sha256Hex(dedupeSource);
	const key = `appleauto:dedupe:${hash}`;

	const existed = await env.kv.get(key);

	if (existed) {
		console.log('[AppleAutoPro] duplicate mail skipped within 60s:', JSON.stringify({
			subject,
			key
		}));
		return true;
	}

	await env.kv.put(key, String(Date.now()), {
		expirationTtl: 60
	});

	return false;
}

async function postWithTimeout(url, init, timeoutMs = 12000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}

function isBusinessSuccess(responseText) {
	try {
		const json = JSON.parse(responseText);

		return (
			json?.ret === 1 ||
			json?.success === true ||
			json?.code === 'SUCCESS' ||
			String(json?.msg || '').toLowerCase() === 'success'
		);
	} catch (e) {
		return false;
	}
}

function shouldRetryAsForm(responseText) {
	return /MAIL_FROM_INVALID|Invalid mail_from|mail_from/i.test(responseText || '');
}

function buildPostalHashPayload({ message, parsedEmail, raw }) {
	const mailFrom = parsedEmail?.from?.address || message?.from || '';
	const rcptTo = message?.to || '';

	const fromHeader = getHeader(parsedEmail, 'from') || formatAddress(parsedEmail?.from, mailFrom);
	const toHeader = getHeader(parsedEmail, 'to') || rcptTo;
	const ccHeader = getHeader(parsedEmail, 'cc') || '';
	const dateHeader = getHeader(parsedEmail, 'date') || '';
	const replyToHeader = getHeader(parsedEmail, 'reply-to') || '';
	const inReplyToHeader = getHeader(parsedEmail, 'in-reply-to') || parsedEmail?.inReplyTo || '';
	const referencesHeader = getHeader(parsedEmail, 'references') || parsedEmail?.references || '';
	const autoSubmittedHeader = getHeader(parsedEmail, 'auto-submitted') || '';

	return {
		// Postal Hash 格式核心字段
		id: parsedEmail?.messageId || crypto.randomUUID(),
		rcpt_to: rcptTo,
		mail_from: mailFrom,
		token: '',
		subject: parsedEmail?.subject || '',
		message_id: parsedEmail?.messageId || '',
		timestamp: Date.now() / 1000,
		size: getRawSize(raw),
		spam_status: '',
		bounce: false,
		received_with_ssl: true,

		// Postal Hash Header 字段
		to: toHeader,
		cc: ccHeader,
		from: fromHeader,
		date: dateHeader,
		in_reply_to: inReplyToHeader,
		references: referencesHeader,
		auto_submitted: autoSubmittedHeader,
		reply_to: replyToHeader,

		// Postal Hash 正文字段
		html_body: parsedEmail?.html || '',
		plain_body: parsedEmail?.text || '',

		// Postal Hash 附件字段
		attachment_quantity: Array.isArray(parsedEmail?.attachments) ? parsedEmail.attachments.length : 0,

		// 额外兼容字段
		raw: raw
	};
}

function buildPostalRawPayload({ message, parsedEmail, raw }) {
	const mailFrom = parsedEmail?.from?.address || message?.from || '';
	const rcptTo = message?.to || '';

	return {
		id: parsedEmail?.messageId || crypto.randomUUID(),
		rcpt_to: rcptTo,
		mail_from: mailFrom,
		message: base64EncodeUtf8(raw),
		base64: true,
		size: getRawSize(raw)
	};
}

async function sendJson(webhookUrl, payload) {
	const res = await postWithTimeout(webhookUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'User-Agent': 'CloudMail-Postal-Compatible-Relay/1.0'
		},
		body: JSON.stringify(payload)
	});

	const responseText = await res.text().catch(() => '');

	return {
		status: res.status,
		ok: res.ok,
		responseText
	};
}

async function sendForm(webhookUrl, payload) {
	const form = new URLSearchParams();

	for (const [key, value] of Object.entries(payload)) {
		form.set(key, value == null ? '' : String(value));
	}

	const res = await postWithTimeout(webhookUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
			'User-Agent': 'CloudMail-Postal-Compatible-Relay/1.0'
		},
		body: form.toString()
	});

	const responseText = await res.text().catch(() => '');

	return {
		status: res.status,
		ok: res.ok,
		responseText
	};
}

async function relay({ env, message, parsedEmail, raw }) {
	try {
		if (env.APPLEAUTO_ENABLED !== '1') {
			return;
		}

		const webhookUrl = env.APPLEAUTO_MAIL_UNLOCK_URL;

		if (!webhookUrl) {
			console.log('[AppleAutoPro] APPLEAUTO_MAIL_UNLOCK_URL is empty, skip.');
			return;
		}

		if (env.APPLEAUTO_ONLY_APPLE !== '0' && !isAppleMail(parsedEmail, message)) {
			console.log('[AppleAutoPro] not actionable Apple unlock mail, skip:', parsedEmail?.from?.address, parsedEmail?.subject);
			return;
		}

		// 60 秒内相同 Apple 解锁邮件只推送一次
		// 解决 Apple ID 邮箱和救援邮箱同属一个域名时，同一事件收到两封通知导致重复推送
		const duplicate = await shouldSkipDuplicate({
			env,
			parsedEmail,
			raw
		});

		if (duplicate) {
			return;
		}

		const mode = env.APPLEAUTO_PAYLOAD_MODE || 'postal_hash_json';

		let payload;

		if (mode === 'postal_raw_json') {
			payload = buildPostalRawPayload({ message, parsedEmail, raw });
		} else {
			payload = buildPostalHashPayload({ message, parsedEmail, raw });
		}

		console.log('[AppleAutoPro] relay start:', JSON.stringify({
			mode,
			mail_from: payload.mail_from,
			rcpt_to: payload.rcpt_to,
			subject: payload.subject || ''
		}));

		let result;

		if (mode === 'postal_hash_form') {
			result = await sendForm(webhookUrl, payload);
		} else {
			result = await sendJson(webhookUrl, payload);
		}

		let businessOk = result.ok && isBusinessSuccess(result.responseText);

		if (!businessOk && shouldRetryAsForm(result.responseText) && mode !== 'postal_hash_form') {
			console.log('[AppleAutoPro] retry as postal hash form because:', result.responseText.slice(0, 500));

			const formPayload = buildPostalHashPayload({ message, parsedEmail, raw });
			result = await sendForm(webhookUrl, formPayload);
			businessOk = result.ok && isBusinessSuccess(result.responseText);
		}

		if (!result.ok || !businessOk) {
			console.error('[AppleAutoPro] webhook business failed:', result.status, result.responseText.slice(0, 1000));
			return;
		}

		console.log('[AppleAutoPro] webhook success:', result.status, result.responseText.slice(0, 1000));
	} catch (e) {
		console.error('[AppleAutoPro] relay error:', e);
	}
}

export default {
	relay
};
