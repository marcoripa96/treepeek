import { highlight } from "./highlight";

type Req = { id: number; code: string; path: string };
type Res = { id: number; html: string | null };

self.addEventListener("message", (event: MessageEvent<Req>) => {
  const { id, code, path } = event.data;
  let html: string | null = null;
  try {
    html = highlight(code, path);
  } catch {
    html = null;
  }
  const res: Res = { id, html };
  (self as unknown as Worker).postMessage(res);
});
