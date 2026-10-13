import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const types = {
	".css": "text/css",
	".html": "text/html",
	".js": "text/javascript",
	".png": "image/png",
};

createServer((request, response) => {
	const pathname = new URL(request.url || "/", "http://localhost").pathname;
	const relative = pathname === "/" ? "tests/visual/index.html" : pathname.replace(/^\//u, "");
	const path = normalize(join(root, relative));
	if (!path.startsWith(root)) {
		response.writeHead(403).end();
		return;
	}
	try {
		const file = statSync(path).isDirectory() ? join(path, "index.html") : path;
		response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
		createReadStream(file).pipe(response);
	} catch {
		response.writeHead(404).end();
	}
}).listen(4179, "127.0.0.1");
