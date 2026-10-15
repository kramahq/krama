import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  restoreVersion,
  useCatalogVersions,
  useRefreshLibrary,
  type CatalogKind,
  type CatalogVersion,
} from '@/api/catalog';
import { Badge, Button, Card, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

export function VersionHistory({
  kind,
  id,
  canManage,
}: {
  kind: CatalogKind;
  id: string;
  canManage: boolean;
}) {
  const versions = useCatalogVersions(kind, id, true);
  const [selected, setSelected] = useState<CatalogVersion>();
  const refresh = useRefreshLibrary();
  const toast = useToast();
  const restore = useMutation({
    mutationFn: (v: CatalogVersion) => restoreVersion(kind, id, v),
    onSuccess: async () => {
      await refresh();
      setSelected(undefined);
      toast.ok('Previous version restored');
    },
  });
  return (
    <Card className="p-4">
      <h2 className="mb-3 font-serif text-xl font-normal">Version history</h2>
      {versions.isLoading ? (
        <Skeleton className="h-16" />
      ) : versions.isError ? (
        <div role="alert" className="text-sm text-bad">
          {versions.error.message}
          <Button className="ml-2" size="sm" onClick={() => void versions.refetch()}>
            Retry history
          </Button>
        </div>
      ) : !versions.data?.length ? (
        <p className="text-sm text-ink3">No installed history is available.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {versions.data.map((v, i) => (
            <li
              key={`${v.sha}-${i}`}
              className="flex flex-wrap items-center gap-2 border-t border-line py-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code title={v.sha}>{v.version ?? v.sha.slice(0, 12)}</code>
                  {v.current && <Badge tone="ok">Current</Badge>}
                  <Badge>{v.action.replace('_', ' ')}</Badge>
                </div>
                <div className="mt-1 text-xs text-ink3">
                  {new Date(v.at).toLocaleString()}
                  {v.by && ` · ${v.by}`}
                </div>
              </div>
              {!v.current && canManage && (
                <Button
                  size="sm"
                  disabled={restore.isPending}
                  onClick={() => {
                    restore.reset();
                    setSelected(v);
                  }}
                  aria-label={`Restore ${v.version ?? v.sha.slice(0, 12)}`}
                >
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {selected && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-3">
          <p className="mt-0 text-sm">
            Restore {selected.version ?? selected.sha.slice(0, 12)} and the permissions recorded
            with it? Active runs may prevent this change.
          </p>
          <div className="flex gap-2">
            <Button
              busy={restore.isPending}
              variant="primary"
              onClick={() => restore.mutate(selected)}
            >
              Confirm restore
            </Button>
            <Button disabled={restore.isPending} onClick={() => setSelected(undefined)}>
              Cancel restore
            </Button>
          </div>
        </div>
      )}
      {restore.isError && (
        <p role="alert" className="text-sm text-bad">
          {restore.error.message}
        </p>
      )}
    </Card>
  );
}
