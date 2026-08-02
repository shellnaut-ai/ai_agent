import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export interface ToolValidationSuccess {
  readonly ok: true;
  readonly value: unknown;
}

export interface ToolValidationFailure {
  readonly ok: false;
  readonly message: string;
}

export type ToolValidationResult =
  | ToolValidationSuccess
  | ToolValidationFailure;

export interface ToolInputValidator {
  validate(input: unknown): ToolValidationResult;
}

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (
      error.params as {
        requiredProperties?: string[];
      }
    ).requiredProperties;
    const requiredProperty = requiredProperties?.[0];

    if (requiredProperty) {
      const basePath = error.instancePath
        .replace(/^\//, "")
        .replace(/\//g, ".");

      return basePath
        ? `${basePath}.${requiredProperty}`
        : requiredProperty;
    }
  }

  const path = error.instancePath
    .replace(/^\//, "")
    .replace(/\//g, ".");

  return path || "root";
}

export function createToolInputValidator(
  toolName: string,
  schema: TSchema,
): ToolInputValidator {
  const validator = Compile(schema);

  return {
    validate(input: unknown): ToolValidationResult {
      const copiedInput = structuredClone(input);
      const convertedInput = Value.Convert(schema, copiedInput);

      if (validator.Check(convertedInput)) {
        return {
          ok: true,
          value: convertedInput,
        };
      }

      const errors =
        validator
          .Errors(convertedInput)
          .map((error) => {
            return (
              `  - ${formatValidationPath(error)}: ` +
              error.message
            );
          })
          .join("\n") || "Unknown validation error";

      return {
        ok: false,
        message:
          `Validation failed for tool "${toolName}":\n` +
          `${errors}\n\nReceived arguments:\n` +
          JSON.stringify(input, null, 2),
      };
    },
  };
}
