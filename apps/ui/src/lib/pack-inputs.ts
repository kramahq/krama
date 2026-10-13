import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Pack } from '@kramahq/contract';

export const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export interface InputField {
  name: string;
  label: string;
  description?: string;
  schema: Record<string, unknown>;
  required: boolean;
  initial: string;
}
export interface InputDraft {
  fields?: Record<string, string>;
  json?: string;
}
export interface InputModel {
  fields: InputField[];
  wholeJson: boolean;
  initialJson: string;
  extraJson: boolean;
  validate?: ValidateFunction;
  problem?: string;
}

/** inputsSchema describes input.params; the user's request text is separate. No coercion or removal of input. */
export function inputModel(schema: Pack['inputsSchema']): InputModel {
  const properties = asObject(schema.properties);
  const wholeJson =
    !properties ||
    ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'patternProperties'].some((key) => key in schema);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields = Object.entries(properties ?? {}).map(([name, value]): InputField => {
    const s = asObject(value) ?? {};
    const initial =
      s.default === undefined
        ? ''
        : s.type === 'string' && !Array.isArray(s.enum)
          ? String(s.default)
          : JSON.stringify(s.default);
    return {
      name,
      label: typeof s.title === 'string' ? s.title : name,
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      schema: s,
      required: required.includes(name),
      initial,
    };
  });
  const defaults = Object.fromEntries(
    fields.filter((f) => f.schema.default !== undefined).map((f) => [f.name, f.schema.default]),
  );
  const model: InputModel = {
    fields,
    wholeJson,
    initialJson: JSON.stringify(wholeJson ? defaults : {}, null, 2),
    extraJson: wholeJson || schema.additionalProperties !== false,
  };
  try {
    const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
    const options = { allErrors: true, strict: false, logger: false as const };
    const ajv = dialect.includes('2020-12')
      ? new Ajv2020(options)
      : dialect.includes('2019-09')
        ? new Ajv2019(options)
        : new Ajv(options);
    addFormats(ajv);
    // A work-item reference is opaque to the UI; its source adapter resolves it.
    ajv.addFormat('work-item', {
      type: 'string',
      validate: (value: string) => value.trim().length > 0,
    });
    // Unknown formats must not silently bypass validation.
    for (const format of findFormats(schema)) {
      if (!ajv.formats[format]) throw new Error(`Unsupported format: ${format}`);
    }
    if (schema.$async) throw new Error('Async schemas are not supported');
    const validate = ajv.compile(schema);
    model.validate = validate;
  } catch {
    model.problem =
      'This pack’s input schema could not be validated. Update the pack before starting a run.';
  }
  return model;
}

function findFormats(value: unknown): Set<string> {
  const formats = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (asObject(node)) {
      const object = asObject(node)!;
      if (typeof object.format === 'string') formats.add(object.format);
      Object.entries(object).forEach(([key, child]) => {
        if (!['default', 'examples', 'const', 'enum'].includes(key)) visit(child);
      });
    }
  };
  visit(value);
  return formats;
}

function errorText(error: ErrorObject): string {
  const path = error.instancePath || 'Inputs';
  return error.keyword === 'required'
    ? `${path}: ${String(error.params.missingProperty)} is required`
    : `${path}: ${error.message ?? 'invalid value'}`;
}

export function readInputs(
  model: InputModel,
  draft: InputDraft,
): {
  params: Record<string, unknown>;
  errors: string[];
} {
  const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const errors: string[] = [];
  if (model.problem) return { params, errors: [model.problem] };
  try {
    const json: unknown = JSON.parse(draft.json ?? model.initialJson);
    if (!asObject(json)) throw new Error('Expected an object');
    Object.assign(params, json);
  } catch {
    errors.push('Additional inputs must be a JSON object.');
  }
  if (!model.wholeJson)
    for (const field of model.fields) {
      const raw =
        draft.fields && Object.hasOwn(draft.fields, field.name)
          ? draft.fields[field.name]!
          : field.initial;
      if (field.name in params)
        errors.push(`${field.label}: use its field instead of additional inputs.`);
      if (raw === '') continue;
      if (field.schema.type === 'string' && !Array.isArray(field.schema.enum)) {
        params[field.name] = raw;
      } else {
        try {
          params[field.name] = JSON.parse(raw);
        } catch {
          errors.push(`${field.label}: enter a valid ${field.schema.type ?? 'JSON value'}.`);
        }
      }
    }
  if (model.validate && !model.validate(params)) {
    errors.push(...(model.validate.errors ?? []).map(errorText));
  }
  return { params, errors };
}
