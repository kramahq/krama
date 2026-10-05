import { Link, type ErrorComponentProps } from '@tanstack/react-router';
import { ApiError } from '@kramahq/sdk';
import { CloudOff, SearchX, TriangleAlert } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui/primitives';

export function NotFound() {
  return (
    <EmptyState
      icon={<SearchX className="size-8" aria-hidden />}
      title="That page does not exist"
      action={
        <Link to="/runs" className="no-underline">
          <Button>Go to Runs</Button>
        </Link>
      }
    >
      The link may be old, or the item may have been removed.
    </EmptyState>
  );
}

/** What a screen shows when its data could not be loaded: says what happened and offers a retry. */
export function LoadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const api = error instanceof ApiError ? error : undefined;
  const unreachable = api?.status === 0;
  return (
    <EmptyState
      icon={
        unreachable ? (
          <CloudOff className="size-8" aria-hidden />
        ) : (
          <TriangleAlert className="size-8" aria-hidden />
        )
      }
      title={
        unreachable
          ? 'Cannot reach the Krama server'
          : api?.status === 404
            ? 'Not found'
            : 'Something went wrong'
      }
      {...(retry ? { action: <Button onClick={retry}>Try again</Button> } : {})}
    >
      {unreachable
        ? 'Check that the server is running. This page will keep trying and recover on its own.'
        : `${api?.message ?? (error instanceof Error ? error.message : 'Unknown error')}${api?.traceId ? ` (trace ${api.traceId})` : ''}`}
    </EmptyState>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return <LoadError error={error} retry={reset} />;
}
