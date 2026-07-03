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

function isAppleMail(parsedEmail) {
	const from = parsedEmail?.from?.address || '';
	const domain = getDomain(from);
	const subject = parsedEmail?.subject || '';

	const domainOk = DEFAULT_APPLE_DOMAINS.some(d => {
		return domain === d || domain.endsWith(`.${d}`);
	});

	const subjectOk = /apple|apple id|apple account|icloud|验证码|验证|解锁|安全|重设|恢复|账户|帐户|verification|verify|unlock|security|reset|recover/i.test(subject);

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

		if (env.APPLEAUTO_ONLY_APPLE !== '0' && !isAppleMail(parsedEmail)) {
			console.log('[AppleAutoPro] not apple mail, skip:', parsedEmail?.from?.address, parsedEmail?.subject);
			return;
		}

		const mode = env.APPLEAUTO_PAYLOAD_MODE || 'raw';

		let body;
		let headers = {
			'User-Agent': 'CloudMail-AppleAutoPro-Relay/1.0',
			'X-CloudMail-To': message.to || '',
			'X-CloudMail-From': parsedEmail?.from?.address || '',
			'X-CloudMail-Subject': parsedEmail?.subject || ''
		};

		if (mode === 'json') {
			headers['Content-Type'] = 'application/json; charset=utf-8';
			body = JSON.stringify({
				to: message.to || '',
				from: parsedEmail?.from?.address || '',
				fromName: parsedEmail?.from?.name || '',
				subject: parsedEmail?.subject || '',
				text: parsedEmail?.text || '',
				html: parsedEmail?.html || '',
				raw
			});
		} else {
			headers['Content-Type'] = 'message/rfc822; charset=utf-8';
			body = raw;
		}

		const res = await postWithTimeout(webhookUrl, {
			method: 'POST',
			headers,
			body
		});

		const responseText = await res.text().catch(() => '');

		if (!res.ok) {
			console.error('[AppleAutoPro] webhook failed:', res.status, responseText.slice(0, 500));
			return;
		}

		console.log('[AppleAutoPro] webhook success:', res.status, responseText.slice(0, 300));
	} catch (e) {
		console.error('[AppleAutoPro] relay error:', e);
	}
}

export default {
	relay
};
