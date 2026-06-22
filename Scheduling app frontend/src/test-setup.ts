// jsdom doesn't implement scrollIntoView; the Chat component calls it on mount.
// Stub it so component tests can render without throwing.
if (typeof Element !== "undefined") {
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
}
