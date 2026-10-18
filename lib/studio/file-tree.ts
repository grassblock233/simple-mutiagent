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
