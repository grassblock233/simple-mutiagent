import styles from "./workflow-studio.module.css";
export function cx(names: string) {
  return names
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => styles[name] ?? name)
    .join(" ");
}
