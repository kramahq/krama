import { Link } from '@tanstack/react-router';
import { Hourglass } from 'lucide-react';
import { Button, EmptyState, PageHeader } from '@/components/ui/primitives';

/** A screen that is in the design and the navigation but not built yet. It says so, and says what comes. */
export function Placeholder({
  title,
  sub,
  task,
  children,
}: {
  title: string;
  sub: string;
  task: string;
  children: string;
}) {
  return (
    <>
      <PageHeader title={title} sub={sub} />
      <EmptyState
        icon={<Hourglass className="size-8" aria-hidden />}
        title="Not built in this preview yet"
        action={
          <Link to="/runs" className="no-underline">
            <Button>Go to Runs</Button>
          </Link>
        }
      >
        {`${children} Planned as ${task}.`}
      </EmptyState>
    </>
  );
}
