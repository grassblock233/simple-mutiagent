export type FileTreeEntry = {
  name: string;
  path: string;
  directory: boolean;
  children: FileTreeEntry[];
};
export type FileScope = { path: string; directory: boolean };

export function buildFileTree(files: string[]): FileTreeEntry[] {
  const root: FileTreeEntry = {
    name: "",
    path: "",
    directory: true,
    children: [],
  };
  const entries = new Map<string, FileTreeEntry>([["", root]]);
  for (const file of files) {
    const parts = file.split("/");
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let entry = entries.get(path);
      if (!entry) {
        entry = {
          name: parts[i],
          path,
          directory: i < parts.length - 1,
          children: [],
        };
        entries.set(path, entry);
        parent.children.push(entry);
      }
      parent = entry;
    }
  }
  function sort(entry: FileTreeEntry) {
    entry.children.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
    entry.children.forEach(sort);
  }
  sort(root);
  return root.children;
}

export function scopeState(
  entry: Pick<FileTreeEntry, "path" | "directory">,
  selection: FileScope[],
) {
  const inherited = selection.some(
    (scope) => scope.directory && entry.path.startsWith(scope.path + "/"),
  );
  return {
    inherited,
    checked: inherited || selection.some((scope) => scope.path === entry.path),
    partial:
      entry.directory &&
      !inherited &&
      !selection.some((scope) => scope.path === entry.path) &&
      selection.some((scope) => scope.path.startsWith(entry.path + "/")),
  };
}

export type VisibleEntry = FileTreeEntry & { depth: number };
export function visibleEntries(tree: FileTreeEntry[], expanded: Set<string>, query: string): VisibleEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const result: VisibleEntry[] = [];
  function visit(entry: FileTreeEntry, depth: number): boolean {
    if (needle) {
      const matches = entry.path.toLocaleLowerCase().includes(needle);
      const children = entry.children.filter(child => matches || descendantMatch(child));
      if (!matches && !children.length) return false;
      result.push({ ...entry, depth }); children.forEach(child => visit(child, depth + 1)); return true;
    }
    result.push({ ...entry, depth });
    if (entry.directory && expanded.has(entry.path)) entry.children.forEach(child => visit(child, depth+1));
    return true;
  }
  function descendantMatch(entry: FileTreeEntry): boolean { return entry.path.toLocaleLowerCase().includes(needle) || entry.children.some(descendantMatch); }
  tree.forEach(entry => visit(entry, 0)); return result;
}
export function coveredFiles(files: string[], selection: FileScope[]) {
  const exact = new Set(selection.filter(s => !s.directory).map(s => s.path));
  const directories = new Set(selection.filter(s => s.directory).map(s => s.path));
  return files.filter(file => exact.has(file) || file.split("/").some((_,i,parts) => directories.has(parts.slice(0,i+1).join("/"))));
}
