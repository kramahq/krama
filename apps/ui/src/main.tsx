import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveProvider } from '@/api/live';
import { ApiError } from '@kramahq/sdk';
import { ProjectProvider } from '@/app/project';
import { createAppRouter } from '@/app/router';
import { initTheme } from '@/app/theme';
import { ToastProvider } from '@/components/ui/toast';
import './styles.css';

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      // A missing or forbidden thing will not appear by asking again; an unreachable server might.
      retry: (count, error) =>
        error instanceof ApiError && error.status >= 400 && error.status < 500 ? false : count < 2,
    },
  },
});
const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LiveProvider>
          <ProjectProvider>
            <RouterProvider router={router} />
          </ProjectProvider>
        </LiveProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
