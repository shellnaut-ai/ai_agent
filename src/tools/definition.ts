import { Memory } from "typebox/system";

import type { ToolDefinition } from "./types.js";

export function cloneToolDefinition(
  definition: ToolDefinition,
): ToolDefinition {
  return cloneMutable(
    Memory.Clone(definition),
  ) as ToolDefinition;
}

export function cloneFrozenToolDefinition(
  definition: ToolDefinition,
): ToolDefinition {
  return deepFreeze(cloneToolDefinition(definition));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    seen.has(value)
  ) {
    return value;
  }

  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }

  return Object.freeze(value);
}

function cloneMutable<T>(
  value: T,
  seen = new Map<object, object>(),
): T {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return value;
  }

  const existing = seen.get(value);

  if (existing !== undefined) {
    return existing as T;
  }

  const clone = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined) {
      continue;
    }

    if ("value" in descriptor) {
      Object.defineProperty(clone, key, {
        value: cloneMutable(descriptor.value, seen),
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    } else {
      Object.defineProperty(clone, key, {
        get: descriptor.get,
        set: descriptor.set,
        enumerable: descriptor.enumerable,
        configurable: true,
      });
    }
  }

  return clone as T;
}
