const tags = new Set([
  "main", "section", "article", "header", "footer", "nav", "aside", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "strong", "em", "small", "b", "i",
  "ul", "ol", "li", "dl", "dt", "dd", "br", "hr", "table", "thead", "tbody", "tr",
  "th", "td", "caption", "form", "fieldset", "legend", "label", "input", "button",
  "select", "option", "textarea", "output", "code", "pre",
]);
const drop = new Set(["script", "style", "iframe", "object", "embed", "template", "svg", "math", "link", "meta", "base", "noscript"]);
const attributes = new Set(["id", "role", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "for", "value", "placeholder", "disabled", "checked", "selected", "readonly", "name"]);
const voidTags = new Set(["input", "br", "hr"]);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function snapshotDocument(source: string): string {
  const document = new DOMParser().parseFromString(source, "text/html");
  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (drop.has(tag)) return "";
    const children = [...element.childNodes].map(serialize).join("");
    if (!tags.has(tag)) return children;
    const attrs = [...element.attributes]
      .filter((attribute) => attributes.has(attribute.name))
      .map((attribute) => ` ${attribute.name}="${escapeHtml(attribute.value)}"`)
      .join("");
    const type = tag === "input" && ["text", "email", "number", "checkbox", "radio", "password"].includes(element.getAttribute("type") ?? "")
      ? ` type="${element.getAttribute("type")}"` : "";
    return `<${tag}${attrs}${type}>${voidTags.has(tag) ? "" : `${children}</${tag}>`}`;
  };
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:#243b36; background:#fbfcfa; font-size:14px; }
    * { box-sizing:border-box; } body { margin:0; padding:26px; overflow-wrap:anywhere; }
    h1,h2,h3 { margin:0 0 18px; font-size:18px; font-weight:650; letter-spacing:-.02em; }
    p { color:#62746e; line-height:1.8; } section, fieldset, form { margin:14px 0; }
    fieldset { border:1px solid #dce4dc; border-radius:8px; padding:18px; }
    label { display:block; font-size:12px; font-weight:600; margin:14px 0 7px; }
    input:not([type=checkbox]):not([type=radio]),textarea,select { display:block; width:100%; max-width:380px; padding:10px 12px; background:white; color:inherit; border:1px solid #d4ddd5; border-radius:6px; font:inherit; }
    button { margin:18px 10px 0 0; padding:11px 18px; background:#176450; color:white; border:0; border-radius:6px; font:600 13px inherit; }
    table { border-collapse:collapse; width:100%; } td,th { text-align:left; padding:8px; border-bottom:1px solid #dce4dc; }
    code,pre { white-space:pre-wrap; } ul,ol { padding-left:20px; }
  </style></head><body inert>${[...document.body.childNodes].map(serialize).join("")}</body></html>`;
}
