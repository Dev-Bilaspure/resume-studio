import { NextResponse, type NextRequest } from "next/server";

// The app only serves this Mac, and must not be usable by web pages open in your browser:
// - DNS rebinding: a site points its own name at 127.0.0.1 to load (and read) your resumes. Refused by
//   only answering requests addressed to this Mac by name.
// - Cross-site requests: a page sends commands to 127.0.0.1 (overwrite files, delete resumes).
//   Anything that changes data is only accepted from the app's own pages.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function forbidden(reason: string) {
  return new NextResponse(`Forbidden: ${reason}`, { status: 403 });
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!LOCAL_HOST.test(host)) return forbidden("this app only answers requests to 127.0.0.1 or localhost");

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    // Browsers send Origin with every such request; it must be this app. (No Origin means a tool on this
    // Mac, like curl, which the host check already limits to local use.)
    const origin = request.headers.get("origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        return forbidden("bad origin");
      }
      if (originHost !== host) return forbidden("changes are only accepted from the app's own pages");
    }
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return forbidden("changes are only accepted from the app's own pages");
  }
  return NextResponse.next();
}
