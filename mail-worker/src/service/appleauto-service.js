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

function isAppleMail(parsedEmail, message) {
	const from = parsedEmail?.from?.address || message?.from || '';
	const domain = getDomain(from);
	const subject = parsedEmail?.subject || '';

	const domainOk = DEFAULT_APPLE_DOMAINS.some(d => {
		return domain === d || domain.endsWith(`.${d}`);
	});

	const subjectOk = /apple|apple id|apple account|icloud|验证码|驗證|验证|解锁|解鎖|安全|重设|重設|恢复|恢復|账户|帳户|帐户|雙重認證|双重认证|two-factor|verification|verify|unlock|security|reset|recover/i.test(subject);

	return domainOk && subjectOk;
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
		// Postal Hash 默认格式核心字段
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

		// Postal Hash 默认 header 字段
		to: toHeader,
		cc: ccHeader,
		from: fromHeader,
		date: dateHeader,
		in_reply_to: inReplyToHeader,
		references: referencesHeader,
		auto_submitted: autoSubmittedHeader,
		reply_to: replyToHeader,

		// Postal Hash 默认正文字段
		html_body: parsedEmail?.html || '',
		plain_body: parsedEmail?.text || '',

		// Postal Hash 默认附件字段
		attachment_quantity: Array.isArray(parsedEmail?.attachments) ? parsedEmail.attachments.length : 0,

		// 额外兼容字段，不影响 Postal 格式
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
			console.log('[AppleAutoPro] not apple mail, skip:', parsedEmail?.from?.address, parsedEmail?.subject);
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

		// 如果对方仍提示 mail_from 无效，说明它可能不是读 JSON body，而是读表单参数；自动用表单重试一次
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
