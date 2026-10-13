import type { InputDraft, InputModel } from '@/lib/pack-inputs';
import { Card } from './ui/primitives';

const control = 'w-full rounded-lg border border-line2 bg-raised px-3 py-2 text-sm';

export function PackInputs({
  model,
  draft,
  onChange,
  errors,
}: {
  model: InputModel;
  draft: InputDraft;
  onChange: (draft: InputDraft) => void;
  errors: string[];
}) {
  const updateField = (name: string, value: string) =>
    onChange({ ...draft, fields: { ...draft.fields, [name]: value } });
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="m-0 text-sm font-medium">Pack inputs</h2>
        <p className="mt-1 mb-0 text-xs text-ink3">
          Details this pack needs alongside your request. Required fields are marked.
        </p>
      </div>
      {!model.problem &&
        !model.wholeJson &&
        model.fields.map((field) => {
          const value =
            draft.fields && Object.hasOwn(draft.fields, field.name)
              ? draft.fields[field.name]!
              : field.initial;
          const options = Array.isArray(field.schema.enum) ? field.schema.enum : undefined;
          return (
            <label key={field.name} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {field.label}
                {field.required && <span className="ml-1 text-xs text-ink3">(required)</span>}
              </span>
              {options ? (
                <select
                  className={control}
                  value={value}
                  onChange={(e) => updateField(field.name, e.target.value)}
                >
                  <option value="">Choose a value</option>
                  {options.map((option, i) => (
                    <option key={i} value={JSON.stringify(option)}>
                      {typeof option === 'string' ? option : JSON.stringify(option)}
                    </option>
                  ))}
                </select>
              ) : field.schema.type === 'boolean' ? (
                <select
                  className={control}
                  value={value}
                  onChange={(e) => updateField(field.name, e.target.value)}
                >
                  <option value="">Not set</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : ['string', 'number', 'integer'].includes(String(field.schema.type)) ? (
                <input
                  className={control}
                  value={value}
                  inputMode={field.schema.type === 'string' ? 'text' : 'decimal'}
                  onChange={(e) => updateField(field.name, e.target.value)}
                />
              ) : (
                <textarea
                  className={`${control} font-mono`}
                  rows={3}
                  value={value}
                  placeholder="JSON value"
                  onChange={(e) => updateField(field.name, e.target.value)}
                />
              )}
              {field.description && <span className="text-xs text-ink3">{field.description}</span>}
            </label>
          );
        })}
      {!model.problem && model.extraJson && (
        <details open={model.wholeJson}>
          <summary className="cursor-pointer text-sm">
            {model.wholeJson ? 'Inputs (JSON)' : 'Additional inputs (JSON)'}
          </summary>
          <label className="mt-2 flex flex-col gap-1.5">
            <span className="text-xs text-ink3">
              Enter a JSON object. Values are checked against this pack’s schema.
            </span>
            <textarea
              aria-label={model.wholeJson ? 'Inputs JSON' : 'Additional inputs JSON'}
              className={`${control} font-mono`}
              rows={5}
              value={draft.json ?? model.initialJson}
              onChange={(e) => onChange({ ...draft, json: e.target.value })}
            />
          </label>
        </details>
      )}
      {errors.length > 0 && (
        <ul
          aria-label="Pack input errors"
          className="m-0 list-inside list-disc p-0 text-xs text-bad"
        >
          {errors.map((error, i) => (
            <li key={i}>{error}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
