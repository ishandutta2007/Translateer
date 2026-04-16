import { serveDir } from "@std/http";
import { resolve } from "@std/path";
import BrowserSession, { browserSession } from "./browser_session.ts";
import { ensureGoogleRpcTemplates } from "./google_rpc.ts";
import { parsePage } from "./parser.ts";

const { PORT = "8999" } = Deno.env.toObject();

console.log("initializing browser session...");

try {
	await new BrowserSession().init();
	await browserSession.withIsolatedPage(async (page) => {
		await ensureGoogleRpcTemplates(page, { validate: true });
	});
} catch (e) {
	console.log("Failed to initialize browser session");
	console.error(e);
	Deno.exit(1);
}

console.log("ready");

// on exit, close the browser session
Deno.addSignalListener("SIGINT", async () => {
	console.log("SIGINT");
	await browserSession.close();
	Deno.exit(0);
});

Deno.serve({ port: parseInt(PORT, 10) }, async (req) => {
	try {
		const url = new URL(req.url);

		if (url.pathname === "/api") {
			const requestBody = await readJsonBody(req);
			const options = {
				text: url.searchParams.get("text"),
				from: url.searchParams.get("from") ?? "auto",
				to: url.searchParams.get("to") ?? "zh-CN",
				audio: url.searchParams.get("audio") === "true",
				...requestBody,
			};

			const { text, from, to } = options;
			const audio = options.audio === true || options.audio === "true";

			if (!text) {
				serverLog(req, 400);
				return new Response(
					JSON.stringify({ error: 1, message: "text is required" }),
					{
						status: 400,
						headers: {
							"Content-Type": "application/json; charset=utf-8",
						},
					},
				);
			}

			try {
				const result = await browserSession.withPage(async (page) => {
						return await parsePage(page, {
							text,
							from,
							to,
							audio,
						});
				});
				serverLog(req, 200);
				return new Response(JSON.stringify(result), {
					status: 200,
					headers: {
						"Content-Type": "application/json; charset=utf-8",
					},
				});
			} catch (e) {
				browserSession.requestRefresh(e);
				serverLog(req, 500);
				console.error(e);
				return new Response(
					JSON.stringify({ error: 1, message: "Internal Server Error" }),
					{
						status: 500,
						headers: {
							"Content-Type": "application/json; charset=utf-8",
						},
					},
				);
			}
		}

		return serveDir(req, {
			fsRoot: resolve(Deno.cwd(), "src", "public"),
		});
	} catch (e) {
		serverLog(req, 500);
		console.error(e);
		return new Response(
			JSON.stringify({
				error: 1,
				message: e instanceof Error ? e.message : "Internal Server Error",
			}),
			{
				status: 500,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
				},
			},
		);
	}
});

async function readJsonBody(req: Request) {
	if (req.method === "GET" || req.method === "HEAD") {
		return {};
	}

	const contentType = req.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return {};
	}

	return await req.json().catch(() => ({}));
}

function serverLog(req: Request, status: number) {
	const d = new Date().toISOString();
	const dateFmt = `[${d.slice(0, 10)} ${d.slice(11, 19)}]`;
	const url = new URL(req.url);
	const s = `${dateFmt} [${req.method}] ${url.pathname}${url.search} ${status}`;
	// deno-lint-ignore no-console
	console.debug(s);
}
