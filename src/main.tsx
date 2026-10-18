import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { AppProvider, loadCuratedData } from './store';
import { getLearner, getSettings } from './services/db';
import { installSyncTriggers } from './services/syncManager';
import './styles/app.css';

registerSW({ immediate: true });

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  try {
    const [data, settings, learner] = await Promise.all([loadCuratedData(), getSettings(), getLearner()]);
    installSyncTriggers();
    // Ask the browser not to evict our IndexedDB/Cache Storage (critical on iOS Safari).
    void navigator.storage?.persist?.();
    root.render(
      <StrictMode>
        <AppProvider data={data} initialSettings={settings} initialLearner={learner}>
          <App />
        </AppProvider>
      </StrictMode>,
    );
  } catch (e) {
    root.render(<div className="boot-error">schwa failed to start: {e instanceof Error ? e.message : String(e)}</div>);
  }
}

void boot();
