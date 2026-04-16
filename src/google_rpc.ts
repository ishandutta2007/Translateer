import type { Page } from "./browser_session.ts";

type CoreRpcTemplateName =
	| "translate"
	| "audio"
	| "targetCards";
type RpcTemplateName = CoreRpcTemplateName | "autocomplete";

type RpcTemplate = {
	name: RpcTemplateName;
	rpcId: string;
	url: string;
	headers: Record<string, string>;
	bodyParams: Record<string, string>;
	fReqJson: unknown;
};

export type BuiltRpcRequest = {
	name: RpcTemplateName;
	responseKey: string;
	rpcId: string;
	url: string;
	headers: Record<string, string>;
	body: string;
	fReq: string;
};

export type GoogleRpcTemplateCache = {
	capturedAt: string;
	sample: {
		text: string;
		from: string;
		to: string;
	};
	autocompleteSample: {
		text: string;
		from: string;
		to: string;
	};
	ids: {
		translate: string;
		audio: string;
		cards: string;
		autocomplete?: string;
	};
	templates: Record<CoreRpcTemplateName, RpcTemplate> & {
		autocomplete?: RpcTemplate;
	};
};

type CapturedRequest = {
	rpcId: string;
	url: string;
	headers: Record<string, string>;
	postData: string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SAMPLE_REQUEST = {
	text: "le petit-déjeuner",
	from: "fr",
	to: "en",
};
const AUTOCOMPLETE_SAMPLE_REQUEST = {
	text: "b",
	from: "en",
	to: "fr",
};
const TEXTAREA_SELECTOR = "textarea[aria-label='Source text']";
const SOURCE_AUDIO_SELECTOR = 'button[aria-label="Listen to source text"]';
const ALLOWED_FORWARD_HEADERS = new Set([
	"content-type",
	"x-goog-ext-174067345-jspb",
	"x-same-domain",
]);

let templateCache: GoogleRpcTemplateCache | null = null;
let initializationPromise: Promise<GoogleRpcTemplateCache> | null = null;

export const ensureGoogleRpcTemplates = async (
	page: Page,
	{ force = false, validate = false }: { force?: boolean; validate?: boolean } =
		{},
) => {
	if (initializationPromise) {
		return await initializationPromise;
	}

	initializationPromise = (async () => {
		const cached = force ? null : templateCache;
		if (
			cached &&
			!isExpired(cached) &&
			(!validate || await validateTemplates(page, cached))
		) {
			templateCache = cached;
			return cached;
		}

		const captured = await captureTemplates(page);
		if (!(await validateTemplates(page, captured))) {
			throw new Error("failed to validate captured Google RPC templates");
		}

		templateCache = captured;
		return captured;
	})();

	try {
		return await initializationPromise;
	} finally {
		initializationPromise = null;
	}
};

export const buildRpcRequest = (
	template: RpcTemplate,
	mutator: (payload: unknown) => unknown,
): BuiltRpcRequest => {
	const nextFReqJson = cloneJson(template.fReqJson);
	const rpcEntry = extractFirstRpcEntry(nextFReqJson, template.rpcId);
	const innerPayload = JSON.parse(rpcEntry[1]);
	rpcEntry[1] = JSON.stringify(mutator(innerPayload));

	const bodyParams = new URLSearchParams(template.bodyParams);
	const fReq = JSON.stringify(nextFReqJson);
	bodyParams.set("f.req", fReq);

	return {
		name: template.name,
		responseKey: template.name,
		rpcId: template.rpcId,
		url: template.url,
		headers: { ...template.headers },
		body: bodyParams.toString(),
		fReq,
	};
};

export const executeGoogleRpc = async (
	page: Page,
	requests: BuiltRpcRequest[],
) => {
	if (requests.length === 0) {
		return {} as Record<
			string,
			{ ok: boolean; status: number; body: string }
		>;
	}

	return await page.evaluate((requests) => {
		const _ = (window as unknown as Window & {
			default_TranslateWebserverUi: Record<string, unknown>;
			WIZ_global_data: Record<string, unknown>;
		}).default_TranslateWebserverUi;
		const win = window as unknown as Window & {
			WIZ_global_data: Record<string, unknown>;
		};

		const createRunner = () => {
			const hm = Object.create(
				(_ as { HM: { prototype: object } }).HM.prototype,
			) as {
				j: unknown;
				v: boolean;
				config: { rL: string };
				UA(): { run(body: string): Promise<string> };
			};

			hm.j = null;
			hm.v = false;
			hm.config = { rL: "mgGpzd" };
			return hm.UA();
		};

		let nextReqId = Math.floor(Date.now() % 1_000_000) +
			Math.floor(Math.random() * 10_000);

		const sendRequest = async (request: BuiltRpcRequest) => {
			const url = new URL(request.url);
			url.searchParams.set("rpcids", request.rpcId);
			url.searchParams.set("f.sid", String(win.WIZ_global_data.FdrFJe ?? ""));
			url.searchParams.set("bl", String(win.WIZ_global_data.cfb2h ?? ""));
			nextReqId += 100000;
			url.searchParams.set("_reqid", String(nextReqId));

			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(request.headers)) {
				headers[key] = value;
			}

			try {
				headers["X-Goog-BatchExecute-Bgr"] = await createRunner().run(
					request.fReq,
				);
			} catch {
				headers["X-Goog-BatchExecute-Bgr"] = await createRunner().run(
					request.fReq,
				);
			}

			if (!headers["Content-Type"] && !headers["content-type"]) {
				headers["Content-Type"] =
					"application/x-www-form-urlencoded;charset=UTF-8";
			}

			const response = await fetch(url.toString(), {
				method: "POST",
				credentials: "include",
				headers,
				body: request.body,
			});

			return {
				ok: response.ok,
				status: response.status,
				body: await response.text(),
			};
		};

		return Promise.all(
			requests.map(async (request) => [
				request.responseKey,
				await sendRequest(request),
			]),
		).then((entries) => Object.fromEntries(entries));
	}, requests);
};

export const getGoogleRpcTemplates = () => {
	if (!templateCache) {
		throw new Error("Google RPC templates are not initialized");
	}

	return templateCache;
};

const isExpired = (cache: GoogleRpcTemplateCache) =>
	Date.now() - new Date(cache.capturedAt).getTime() > CACHE_TTL_MS;

const validateTemplates = async (
	page: Page,
	cache: GoogleRpcTemplateCache,
) => {
	try {
		const translateRequest = buildRpcRequest(
			cache.templates.translate,
			(payload) => {
				const next = cloneJson(payload);
				if (!Array.isArray(next) || !Array.isArray(next[0])) {
					throw new Error("unexpected translation template payload");
				}

				next[0][0] = SAMPLE_REQUEST.text;
				next[0][1] = SAMPLE_REQUEST.from;
				next[0][2] = SAMPLE_REQUEST.to;
				return next;
			},
		);

		const translateResponse = await executeGoogleRpc(page, [translateRequest]);
		const translatePayload = extractRpcPayload(
			translateResponse.translate.body,
			cache.ids.translate,
		);
		const translatedText = extractTranslatedText(translatePayload);
		if (!translatedText) {
			return false;
		}

		const cardsRequest = buildRpcRequest(
			cache.templates.targetCards,
			(payload) => {
				const next = cloneJson(payload);
				if (!Array.isArray(next) || !Array.isArray(next[0])) {
					throw new Error("unexpected target cards template payload");
				}

				next[0][0] = translatedText;
				next[0][1] = SAMPLE_REQUEST.to;
				next[0][2] = SAMPLE_REQUEST.from;
				return next;
			},
		);
		const audioRequest = buildRpcRequest(
			cache.templates.audio,
			(payload) => {
				const next = cloneJson(payload);
				if (!Array.isArray(next)) {
					throw new Error("unexpected audio template payload");
				}

				next[0] = SAMPLE_REQUEST.text;
				next[1] = SAMPLE_REQUEST.from;
				return next;
			},
		);

		const secondaryResponses = await executeGoogleRpc(page, [
			cardsRequest,
			audioRequest,
		]);
		const cardsPayload = extractRpcPayload(
			secondaryResponses.targetCards.body,
			cache.ids.cards,
		);
		const cardRoot = Array.isArray(cardsPayload) ? cardsPayload[0] : undefined;
		const audioBase64 = extractAudioBase64FromBody(
			secondaryResponses.audio.body,
		);

		const autocompleteTemplate = cache.templates.autocomplete;
		if (cache.ids.autocomplete && autocompleteTemplate) {
			const autocompleteRequest = buildRpcRequest(
				autocompleteTemplate,
				(payload) => {
					const next = cloneJson(payload);
					if (!Array.isArray(next)) {
						throw new Error("unexpected autocomplete template payload");
					}

					next[0] = AUTOCOMPLETE_SAMPLE_REQUEST.text;
					next[1] = AUTOCOMPLETE_SAMPLE_REQUEST.from;
					next[2] = AUTOCOMPLETE_SAMPLE_REQUEST.to;
					return next;
				},
			);
			const autocompleteResponse = await executeGoogleRpc(page, [
				autocompleteRequest,
			]);
			const autocompletePayload = extractRpcPayload(
				autocompleteResponse.autocomplete.body,
				cache.ids.autocomplete,
			);
			if (
				!Array.isArray(autocompletePayload) ||
				!Array.isArray(autocompletePayload[0])
			) {
				return false;
			}
		}

		return Boolean(
			Array.isArray(cardRoot) &&
				typeof cardRoot[0] === "string" &&
				audioBase64,
		);
	} catch {
		return false;
	}
};

const captureTemplates = async (
	page: Page,
): Promise<GoogleRpcTemplateCache> => {
	const ids = await page.evaluate(() => {
		const root = (window as unknown as Window & {
			default_TranslateWebserverUi: Record<string, unknown>;
		}).default_TranslateWebserverUi;
		const translate = root.jOa as { getName(): string } | undefined;
		const audio = root.nOa as { getName(): string } | undefined;
		const autocomplete = root.cOa as { getName(): string } | undefined;
		const cards = root.Qu as { getName(): string } | undefined;

		if (!translate?.getName || !audio?.getName || !cards?.getName) {
			throw new Error("failed to discover Google RPC ids");
		}

		return {
			translate: translate.getName(),
			audio: audio.getName(),
			cards: cards.getName(),
			autocomplete: autocomplete?.getName(),
		};
	});

	await page.goto(
		`https://translate.google.com/details?sl=${AUTOCOMPLETE_SAMPLE_REQUEST.from}&tl=${AUTOCOMPLETE_SAMPLE_REQUEST.to}&op=translate`,
		{
			waitUntil: "networkidle2",
		},
	);
	await handlePrivacyConsent(page);

	const capturedRequests: CapturedRequest[] = [];
	const onRequest = (request: {
		url(): string;
		headers(): Record<string, string>;
		postData(): string | undefined;
	}) => {
		const url = request.url();
		if (!url.includes("/data/batchexecute")) {
			return;
		}

		const rpcId = new URL(url).searchParams.get("rpcids");
		const postData = request.postData();
		if (!rpcId || !postData) {
			return;
		}

		capturedRequests.push({
			rpcId,
			url,
			headers: request.headers(),
			postData,
		});
	};

	page.on("request", onRequest);

	try {
		await page.bringToFront();
		await page.waitForSelector(TEXTAREA_SELECTOR, { timeout: 10000 });
		await page.click(TEXTAREA_SELECTOR, { clickCount: 3 });
		await page.keyboard.press("Backspace");
		await page.keyboard.type(AUTOCOMPLETE_SAMPLE_REQUEST.text, { delay: 150 });
		await sleep(1000);

		await page.goto(
			`https://translate.google.com/details?sl=${SAMPLE_REQUEST.from}&tl=${SAMPLE_REQUEST.to}&op=translate`,
			{
				waitUntil: "networkidle2",
			},
		);
		await handlePrivacyConsent(page);
		await page.waitForSelector(TEXTAREA_SELECTOR, { timeout: 10000 });
		await page.evaluate(
			(selector, text) => {
				const textarea = document.querySelector(selector);
				if (!(textarea instanceof HTMLTextAreaElement)) {
					throw new Error("source textarea not found");
				}

				textarea.focus();
				const descriptor = Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				);
				if (descriptor?.set) {
					descriptor.set.call(textarea, text);
				} else {
					textarea.value = text;
				}

				textarea.dispatchEvent(
					new InputEvent("input", {
						bubbles: true,
						composed: true,
						data: text,
						inputType: "insertText",
					}),
				);
				textarea.dispatchEvent(new Event("change", { bubbles: true }));
			},
			TEXTAREA_SELECTOR,
			SAMPLE_REQUEST.text,
		);

		await page.waitForFunction(() => {
			const details = document.querySelector("c-wiz[role='complementary']");
			return Boolean(details?.textContent?.trim());
		}, { timeout: 15000 }).catch(() => {});
		await sleep(1500);

		await page.waitForSelector(SOURCE_AUDIO_SELECTOR, { timeout: 5000 })
			.catch(() => undefined);
		const listenButton = await page.$(SOURCE_AUDIO_SELECTOR);
		if (!listenButton) {
			throw new Error("failed to find source audio button during capture");
		}

		await listenButton.click().catch((error) => {
			throw new Error(`failed to click source audio button: ${error}`);
		});
		await sleep(1500);
	} finally {
		page.off("request", onRequest);
	}

	const selectTemplate = (name: RpcTemplateName) => {
		switch (name) {
			case "translate":
				return capturedRequests.find((request) =>
					request.rpcId === ids.translate &&
					request.postData.includes(encodeURIComponent(SAMPLE_REQUEST.text))
				);
			case "audio":
				return capturedRequests.find((request) => request.rpcId === ids.audio);
			case "targetCards":
				return capturedRequests.find((request) =>
					request.rpcId === ids.cards &&
					getCardsDirection(request.postData, ids.cards) === 2
				);
		}
	};

	const templateNames: CoreRpcTemplateName[] = [
		"translate",
		"audio",
		"targetCards",
	];
	const templates = Object.fromEntries(
		templateNames.map((name) => {
			const request = selectTemplate(name);
			if (!request) {
				throw new Error(`failed to capture ${name} template`);
			}

			const params = new URLSearchParams(request.postData);
			const fReqJson = JSON.parse(params.get("f.req") ?? "null");
			const bodyParams: Record<string, string> = {};
			params.forEach((value, key) => {
				if (key !== "f.req") {
					bodyParams[key] = value;
				}
			});
			const headers = Object.fromEntries(
				Object.entries(request.headers).filter(([key]) =>
					ALLOWED_FORWARD_HEADERS.has(key.toLowerCase())
				),
			);

			return [
				name,
				{
					name,
					rpcId: request.rpcId,
					url: request.url,
					headers,
					bodyParams,
					fReqJson,
				} satisfies RpcTemplate,
			];
		}),
	) as Record<CoreRpcTemplateName, RpcTemplate> & {
		autocomplete?: RpcTemplate;
	};

	if (ids.autocomplete) {
		const autocompleteRequest = capturedRequests.find((request) =>
			request.rpcId === ids.autocomplete
		);
		if (autocompleteRequest) {
			const params = new URLSearchParams(autocompleteRequest.postData);
			const fReqJson = JSON.parse(params.get("f.req") ?? "null");
			const bodyParams: Record<string, string> = {};
			params.forEach((value, key) => {
				if (key !== "f.req") {
					bodyParams[key] = value;
				}
			});
			const headers = Object.fromEntries(
				Object.entries(autocompleteRequest.headers).filter(([key]) =>
					ALLOWED_FORWARD_HEADERS.has(key.toLowerCase())
				),
			);
			templates.autocomplete = {
				name: "autocomplete",
				rpcId: autocompleteRequest.rpcId,
				url: autocompleteRequest.url,
				headers,
				bodyParams,
				fReqJson,
			};
		}
	}

	return {
		capturedAt: new Date().toISOString(),
		sample: SAMPLE_REQUEST,
		autocompleteSample: AUTOCOMPLETE_SAMPLE_REQUEST,
		ids,
		templates,
	};
};

const handlePrivacyConsent = async (page: Page) => {
	try {
		await page.waitForSelector('button[aria-label="Reject all"]', {
			timeout: 1000,
		});
		await page.click('button[aria-label="Reject all"]');
	} catch {
		// Ignore when the consent dialog is absent.
	}
};

const getCardsDirection = (postData: string, rpcId: string) => {
	const entry = extractFirstRpcEntry(
		JSON.parse(
			new URLSearchParams(postData).get(
				"f.req",
			) ?? "null",
		),
		rpcId,
	);
	const innerPayload = JSON.parse(entry[1]);
	return Array.isArray(innerPayload) ? innerPayload[1] : undefined;
};

const extractFirstRpcEntry = (fReqJson: unknown, rpcId: string) => {
	if (!Array.isArray(fReqJson) || !Array.isArray(fReqJson[0])) {
		throw new Error(`unexpected f.req envelope for ${rpcId}`);
	}

	const entry = fReqJson[0].find((item: unknown) =>
		Array.isArray(item) && item[0] === rpcId
	);
	if (
		!Array.isArray(entry) || typeof entry[1] !== "string"
	) {
		throw new Error(`missing RPC entry for ${rpcId}`);
	}

	return entry as [string, string, unknown?, unknown?];
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const extractBatchedJsonChunks = (body: string) => {
	const lines = body.split("\n").filter(Boolean);
	const chunks: unknown[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === ")]}'") {
			continue;
		}

		if (/^\d+$/.test(lines[i]) && i + 1 < lines.length) {
			const candidate = lines[i + 1];
			if (candidate.startsWith("[")) {
				try {
					chunks.push(JSON.parse(candidate));
				} catch {
					// Ignore non-JSON chunks in the batchexecute envelope.
				}
			}
			i += 1;
		}
	}

	return chunks;
};

export const extractRpcPayload = (body: string, rpcId: string) => {
	const wrbEntry = extractBatchedJsonChunks(body)
		.flatMap((chunk) => Array.isArray(chunk) ? chunk : [])
		.find((entry) =>
			Array.isArray(entry) &&
			entry[0] === "wrb.fr" &&
			entry[1] === rpcId &&
			typeof entry[2] === "string"
		);

	if (!wrbEntry || typeof wrbEntry[2] !== "string") {
		throw new Error(`missing RPC payload for ${rpcId}`);
	}

	return JSON.parse(wrbEntry[2]);
};

export const extractAudioBase64FromBody = (body: string) => {
	const wrbEntry = extractBatchedJsonChunks(body)
		.flatMap((chunk) => Array.isArray(chunk) ? chunk : [])
		.find((entry) =>
			Array.isArray(entry) &&
			entry[0] === "wrb.fr" &&
			typeof entry[2] === "string"
		);

	if (!wrbEntry || typeof wrbEntry[2] !== "string") {
		return undefined;
	}

	try {
		const payload = JSON.parse(wrbEntry[2]);
		return Array.isArray(payload) && typeof payload[0] === "string"
			? payload[0]
			: undefined;
	} catch {
		return undefined;
	}
};

const extractTranslatedText = (payload: unknown) => {
	if (!Array.isArray(payload)) {
		return undefined;
	}

	return typeof payload[1]?.[0]?.[0]?.[5]?.[0]?.[0] === "string"
		? payload[1][0][0][5][0][0]
		: undefined;
};
