import type { Message } from "../model/types.js";
import type { SessionEntry } from "./types.js";

export interface SessionTreeNode {
  readonly entry: SessionEntry;
  readonly children: readonly SessionTreeNode[];
}

function describeMessage(message: Message): string {
  if (message.role === "user") {
    return `user: ${message.content}`;
  }

  if (message.role === "assistant") {
    if (message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((call) => call.name).join(", ");
      return `assistant tool-call: ${calls}`;
    }

    return `assistant: ${message.content}`;
  }

  return `tool: ${message.content}`;
}

function describeEntry(entry: SessionEntry): string {
  if (entry.type === "message") {
    return describeMessage(entry.message);
  }

  if (entry.type === "compaction") {
    return `compaction: ${entry.summary}`;
  }

  return `leaf: ${entry.targetId}`;
}

function shorten(text: string, maxLength: number): string {
  const compacted = text.replace(/\s+/g, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength - 1)}…`;
}

export function buildSessionTree(
  entries: readonly SessionEntry[],
): readonly SessionTreeNode[] {
  const nodesById = new Map<
    string,
    { entry: SessionEntry; children: SessionTreeNode[] }
  >();

  for (const entry of entries) {
    if (entry.type === "leaf") {
      continue;
    }

    nodesById.set(entry.id, {
      entry: structuredClone(entry),
      children: [],
    });
  }

  const roots: SessionTreeNode[] = [];

  for (const node of nodesById.values()) {
    const parentId = node.entry.parentId;

    if (parentId === null) {
      roots.push(node);
      continue;
    }

    const parent = nodesById.get(parentId);

    if (!parent) {
      throw new Error(
        `Session tree entry "${node.entry.id}" has a missing parent.`,
      );
    }

    parent.children.push(node);
  }

  return roots;
}

export function formatSessionTree(
  roots: readonly SessionTreeNode[],
  leafId: string | null,
): string {
  if (roots.length === 0) {
    return "(session tree is empty)";
  }

  const lines: string[] = [];

  const visit = (
    node: SessionTreeNode,
    prefix: string,
    isLast: boolean,
    isRoot: boolean,
  ): void => {
    const branch = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const marker = node.entry.id === leafId ? " *" : "";
    const description = shorten(describeEntry(node.entry), 80);

    lines.push(
      `${prefix}${branch}${node.entry.id}${marker} ${description}`,
    );

    const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;

    node.children.forEach((child, index) => {
      visit(
        child,
        childPrefix,
        index === node.children.length - 1,
        false,
      );
    });
  };

  roots.forEach((root, index) => {
    visit(root, "", index === roots.length - 1, true);
  });

  return `${lines.join("\n")}\n* current leaf`;
}
