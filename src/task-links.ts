const localLink = /!?\[([^\]\n]+)\]\(<?((?:file:\/\/|\/(?:home|Users|tmp|private)\/|\.{1,2}\/|https:\/\/app\.sokosumi\.com\/(?:home|Users|tmp)\/)[^\n)]*)>?\)/g;

export function hasLocalLinks(text: string): boolean {
  return new RegExp(localLink).test(text);
}

export function readableTaskText(text: string): string {
  if (!hasLocalLinks(text)) return text;
  return text.replace(localLink, "$1 (local artifact; upload required)") +
    "\n\nSome referenced artifacts remain local and need uploading to this Sokosumi task.";
}
