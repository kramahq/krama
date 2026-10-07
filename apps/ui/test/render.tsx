import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { LiveProvider } from '@/api/live';
import { ProjectProvider } from '@/app/project';
import { createAppRouter } from '@/app/router';
import { ToastProvider } from '@/components/ui/toast';

/** The real app, on an in-memory history, with the API mocked (see api-mock.ts). */
export function renderApp(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <LiveProvider>
          <ProjectProvider>
            <RouterProvider router={router} />
          </ProjectProvider>
        </LiveProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, qc };
}
