import type { Page } from "./browser_session.ts";
import { browserSession } from "./browser_session.ts";
import {
	buildRpcRequest,
	type BuiltRpcRequest,
	ensureGoogleRpcTemplates,
	executeGoogleRpc,
	extractAudioBase64FromBody,
	extractRpcPayload,
	getGoogleRpcTemplates,
	type GoogleRpcTemplateCache,
} from "./google_rpc.ts";

type IExamples = string[];

type IAudio = {
	source?: string;
	translation?: string;
	dictionary?: string;
};

type IFromSuggestions = {
	text: string;
	translation: string;
}[];

type IDefinitions = Record<
	string,
	{
		definition: string;
		example?: string;
		labels?: string[];
		synonyms?: Record<string, string[]>;
	}[]
>;

type ITranslations = Record<
	string,
	{
		translation: string;
		reversedTranslations: string[];
		frequency: string;
	}[]
>;

type TranslationResult = {
	result: string;
	resolvedFrom: string;
	detectedLanguage?: string;
	didYouMean?: string;
	sourcePronunciation?: string;
};

type CardResult = {
	headword?: string;
	pronunciation?: string;
	examples?: IExamples;
	definitions?: IDefinitions;
	translations?: ITranslations;
};

const PART_OF_SPEECH_LABELS: Record<number, string> = {
	1: "noun",
	2: "verb",
	3: "adjective",
	4: "adverb",
	5: "pronoun",
	6: "preposition",
	7: "conjunction",
	8: "interjection",
	9: "phrase",
};

const FREQUENCY_LABELS: Record<number, string> = {
	1: "common",
	2: "uncommon",
	3: "rare",
};

export const parsePage = async (
	page: Page,
	{
		text,
		from,
		to,
		audio,
	}: {
		text: string;
		from: string;
		to: string;
		audio: boolean;
	},
) => {
	await ensureGoogleRpcTemplates(page);
	return await parseViaGoogleRpc(page, {
		text,
		from,
		to,
		audio,
	}, true);
};

const parseViaGoogleRpc = async (
	page: Page,
	options: {
		text: string;
		from: string;
		to: string;
		audio: boolean;
	},
	allowReinitialize: boolean,
) => {
	const templates = getGoogleRpcTemplates();

	try {
		const translationRequest = buildTranslationRequest(
			templates,
			options.text,
			options.from,
			options.to,
		);
		const requests: BuiltRpcRequest[] = [translationRequest];
		const shouldFetchSuggestions = options.from !== "auto" &&
			Boolean(templates.templates.autocomplete && templates.ids.autocomplete);
		if (shouldFetchSuggestions) {
			requests.push(
				buildAutocompleteRequest(
					templates,
					options.text,
					options.from,
					options.to,
				),
			);
		}

		const translationResponses = await executeGoogleRpc(page, requests);
		const translationPayload = extractRpcPayload(
			translationResponses.translate.body,
			templates.ids.translate,
		);
		const translation = parseTranslationPayload(
			translationPayload,
			options.text,
			options.from,
		);
		const suggestions = shouldFetchSuggestions && templates.ids.autocomplete
			? parseAutocompletePayload(
				extractRpcPayload(
					translationResponses.autocomplete.body,
					templates.ids.autocomplete,
				),
			)
			: undefined;

		if (!translation.result) {
			throw new Error("missing translated text from Google RPC response");
		}

		const targetCardsRequest = buildTargetCardsRequest(
			templates,
			translation.result,
			options.to,
			translation.resolvedFrom,
		);
		const cardResponses = await executeGoogleRpc(page, [targetCardsRequest]);
		const targetCards = parseCardsPayload(
			extractRpcPayload(cardResponses.targetCards.body, templates.ids.cards),
		);

		let audioData: IAudio | undefined;
		if (options.audio) {
			audioData = await fetchAudioData(
				page,
				templates,
				options.text,
				translation.result,
				targetCards.headword,
				translation.resolvedFrom,
				options.to,
			);
		}

		const hasAudio = Boolean(
			audioData &&
				(audioData.source || audioData.translation || audioData.dictionary),
		);

		return {
			result: translation.result,
			...((translation.detectedLanguage ||
				translation.didYouMean ||
				suggestions ||
				translation.sourcePronunciation) && {
				from: {
					...(translation.detectedLanguage && {
						detectedLanguage: translation.detectedLanguage,
					}),
					...(translation.didYouMean && { didYouMean: translation.didYouMean }),
					...(suggestions && { suggestions }),
					...(translation.sourcePronunciation && {
						pronunciation: translation.sourcePronunciation,
					}),
				},
			}),
			...(targetCards.pronunciation &&
				{ pronunciation: targetCards.pronunciation }),
			...(hasAudio && { audio: audioData }),
			...(targetCards.examples && {
				examples: targetCards.examples,
			}),
			...(targetCards.definitions && {
				definitions: targetCards.definitions,
			}),
			...(targetCards.translations && {
				translations: targetCards.translations,
			}),
		};
	} catch (error) {
		if (!allowReinitialize) {
			throw error;
		}

		await browserSession.withIsolatedPage(async (isolatedPage) => {
			await ensureGoogleRpcTemplates(isolatedPage, {
				force: true,
				validate: true,
			});
		});
		return await parseViaGoogleRpc(page, options, false);
	}
};

const buildTranslationRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) =>
	buildRpcRequest(templates.templates.translate, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next) || !Array.isArray(next[0])) {
			throw new Error("unexpected translation payload template");
		}

		next[0][0] = text;
		next[0][1] = from;
		next[0][2] = to;
		return next;
	});

const buildTargetCardsRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) =>
	buildRpcRequest(templates.templates.targetCards, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next) || !Array.isArray(next[0])) {
			throw new Error("unexpected target cards payload template");
		}

		next[0][0] = text;
		next[0][1] = from;
		next[0][2] = to;
		return next;
	});

const buildAudioRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	lang: string,
) =>
	buildRpcRequest(templates.templates.audio, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next)) {
			throw new Error("unexpected audio payload template");
		}

		next[0] = text;
		next[1] = lang;
		return next;
	});

const buildAutocompleteRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) => {
	const template = templates.templates.autocomplete;
	if (!template) {
		throw new Error("autocomplete template is not initialized");
	}

	return buildRpcRequest(template, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next)) {
			throw new Error("unexpected autocomplete payload template");
		}

		next[0] = text;
		next[1] = from;
		next[2] = to;
		return next;
	});
};

const fetchAudioData = async (
	page: Page,
	templates: GoogleRpcTemplateCache,
	sourceText: string,
	translatedText: string,
	dictionaryHeadword: string | undefined,
	sourceLang: string,
	targetLang: string,
) => {
	const requests: BuiltRpcRequest[] = [
		{
			...buildAudioRequest(templates, sourceText, sourceLang),
			responseKey: "sourceAudio",
		},
		{
			...buildAudioRequest(templates, translatedText, targetLang),
			responseKey: "translationAudio",
		},
	];

	const normalizedHeadword = dictionaryHeadword?.trim();
	const needsDictionaryAudio = normalizedHeadword &&
		normalizedHeadword !== translatedText;
	if (needsDictionaryAudio) {
		requests.push({
			...buildAudioRequest(templates, normalizedHeadword, targetLang),
			responseKey: "dictionaryAudio",
		});
	}

	const responses = await executeGoogleRpc(page, requests);
	const sourceAudio = extractAudioBase64FromBody(responses.sourceAudio.body);
	const translationAudio = extractAudioBase64FromBody(
		responses.translationAudio.body,
	);
	const dictionaryAudio = needsDictionaryAudio
		? extractAudioBase64FromBody(responses.dictionaryAudio.body)
		: translationAudio;

	return {
		...(sourceAudio && { source: toAudioDataUrl(sourceAudio) }),
		...(translationAudio && { translation: toAudioDataUrl(translationAudio) }),
		...(dictionaryAudio && { dictionary: toAudioDataUrl(dictionaryAudio) }),
	} satisfies IAudio;
};

const parseTranslationPayload = (
	payload: unknown,
	sourceText: string,
	requestedFrom: string,
): TranslationResult => {
	if (!Array.isArray(payload)) {
		throw new Error("unexpected translation payload");
	}

	const result = payload[1]?.[0]?.[0]?.[5]?.[0]?.[0];
	if (typeof result !== "string" || result.trim() === "") {
		throw new Error("translation payload does not include text");
	}

	const detectedLanguage =
		requestedFrom === "auto" && typeof payload[2] === "string" &&
			payload[2]
			? payload[2]
			: undefined;
	const resolvedFrom = detectedLanguage ?? requestedFrom;
	const correctionEntry = payload[0]?.[1]?.[0]?.[0];
	const correctedText = cleanText(
		asString(correctionEntry?.[4]) ?? asString(correctionEntry?.[1]),
	);
	const sourcePronunciation = cleanText(
		asString(payload[0]?.[0]) ?? asString(payload[3]?.[6]),
	);
	const didYouMean = correctedText &&
			correctedText.toLowerCase() !== cleanText(sourceText)?.toLowerCase()
		? correctedText
		: undefined;

	return {
		result: cleanText(result) ?? result,
		resolvedFrom,
		...(detectedLanguage && { detectedLanguage }),
		...(didYouMean && { didYouMean }),
		...(sourcePronunciation && { sourcePronunciation }),
	};
};

const parseAutocompletePayload = (
	payload: unknown,
): IFromSuggestions | undefined => {
	if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
		return undefined;
	}

	const suggestions = payload[0]
		.map((entry) => {
			if (!Array.isArray(entry)) {
				return undefined;
			}

			const text = cleanText(asString(entry[0]));
			if (!text) {
				return undefined;
			}

			return {
				text,
				translation: cleanText(asString(entry[1])) ?? "",
			};
		})
		.filter((entry): entry is IFromSuggestions[number] => Boolean(entry));

	return suggestions.length > 0 ? suggestions : undefined;
};

const parseCardsPayload = (payload: unknown): CardResult => {
	if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
		return {};
	}

	const root = payload[0];
	const headword = cleanText(asString(root[0]));
	const definitions = parseDefinitions(root[1]);
	const examples = parseExamples(root[2]);
	const translations = parseTranslations(root[5]);
	const pronunciation = cleanText(asString(root[6]));

	return {
		...(headword && { headword }),
		...(pronunciation && { pronunciation }),
		...(examples && { examples }),
		...(definitions && { definitions }),
		...(translations && { translations }),
	};
};

const parseDefinitions = (section: unknown): IDefinitions | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const definitions: IDefinitions = {};
	for (const group of section[0]) {
		if (!Array.isArray(group) || !Array.isArray(group[1])) {
			continue;
		}

		const partOfSpeech = getPartOfSpeechLabel(group[3]);
		const entries = group[1]
			.map((entry) => parseDefinitionEntry(entry))
			.filter((entry) => entry !== undefined);

		if (entries.length === 0) {
			continue;
		}

		definitions[partOfSpeech] = entries;
	}

	return Object.keys(definitions).length > 0 ? definitions : undefined;
};

const parseDefinitionEntry = (entry: unknown) => {
	if (!Array.isArray(entry)) {
		return undefined;
	}

	const definition = cleanText(asString(entry[0]));
	if (!definition) {
		return undefined;
	}

	const example = cleanText(asString(entry[1]));
	const labels = extractNestedStrings(entry[4]);
	const synonyms = parseSynonymGroups(entry[5]);

	return {
		definition,
		...(example && { example }),
		...(labels.length > 0 && { labels }),
		...(Object.keys(synonyms).length > 0 && { synonyms }),
	};
};

const parseSynonymGroups = (value: unknown) => {
	const groups = Array.isArray(value) ? value : [];
	const synonyms: Record<string, string[]> = {};

	for (const group of groups) {
		if (!Array.isArray(group)) {
			continue;
		}

		const words = extractNestedStrings(group[0]);
		if (words.length === 0) {
			continue;
		}

		const labels = extractNestedStrings(group[1]);
		const key = labels.length > 0 ? labels.join(", ") : "common";
		synonyms[key] = Array.from(new Set(words));
	}

	return synonyms;
};

const parseExamples = (section: unknown): IExamples | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const examples = section[0]
		.map((entry) => {
			if (!Array.isArray(entry)) {
				return undefined;
			}

			return cleanText(asString(entry[1] ?? entry[0]));
		})
		.filter((example): example is string => Boolean(example));

	return examples.length > 0 ? examples : undefined;
};

const parseTranslations = (section: unknown): ITranslations | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const translations: ITranslations = {};
	for (const group of section[0]) {
		if (!Array.isArray(group) || !Array.isArray(group[1])) {
			continue;
		}

		const entries = group[1];
		const partOfSpeech = getPartOfSpeechLabel(group[4]);
		const parsedEntries = entries
			.map((entry) => parseTranslationEntry(entry))
			.filter((entry) => entry !== undefined);

		if (parsedEntries.length === 0) {
			continue;
		}

		translations[partOfSpeech] = parsedEntries;
	}

	return Object.keys(translations).length > 0 ? translations : undefined;
};

const parseTranslationEntry = (entry: unknown) => {
	if (!Array.isArray(entry)) {
		return undefined;
	}

	const translation = cleanText(asString(entry[0]));
	if (!translation) {
		return undefined;
	}

	return {
		translation,
		reversedTranslations: extractNestedStrings(entry[2]),
		frequency: getFrequencyLabel(entry[3]),
	};
};

const getPartOfSpeechLabel = (value: unknown) => {
	const numeric = typeof value === "number" ? value : undefined;
	if (!numeric) {
		return "unknown";
	}

	return PART_OF_SPEECH_LABELS[numeric] ?? `part_of_speech_${numeric}`;
};

const getFrequencyLabel = (value: unknown) => {
	const numeric = typeof value === "number" ? value : undefined;
	if (!numeric) {
		return "";
	}

	return FREQUENCY_LABELS[numeric] ?? `tier_${numeric}`;
};

const extractNestedStrings = (value: unknown): string[] => {
	if (typeof value === "string") {
		const cleaned = cleanText(value);
		return cleaned ? [cleaned] : [];
	}

	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((item) => extractNestedStrings(item));
};

const asString = (value: unknown) =>
	typeof value === "string" ? value : undefined;

const cleanText = (value?: string | null) => {
	if (!value) {
		return undefined;
	}

	const decoded = decodeHtml(stripHtml(value));
	return decoded
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim() || undefined;
};

const stripHtml = (value: string) => value.replace(/<[^>]+>/g, "");

const decodeHtml = (value: string) =>
	value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");

const detectAudioMimeTypeFromBase64 = (base64: string) => {
	const bytes = Uint8Array.from(
		atob(base64.slice(0, 64)),
		(char) => char.charCodeAt(0),
	);

	if (
		bytes[0] === 0x49 &&
		bytes[1] === 0x44 &&
		bytes[2] === 0x33
	) {
		return "audio/mpeg";
	}

	if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		return "audio/mpeg";
	}

	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46
	) {
		return "audio/wav";
	}

	if (
		bytes[0] === 0x4f &&
		bytes[1] === 0x67 &&
		bytes[2] === 0x67 &&
		bytes[3] === 0x53
	) {
		return "audio/ogg";
	}

	return "application/octet-stream";
};

const toAudioDataUrl = (base64: string) =>
	`data:${detectAudioMimeTypeFromBase64(base64)};base64,${base64}`;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));
