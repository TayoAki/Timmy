import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/ui.css';
import './styles/views.css';
import './styles/kit.css';
import './styles/tasks.css';
import './styles/calendar.css';
import './styles/docs.css';
import './styles/projects.css';
import './styles/people.css';
import './styles/files.css';
import './styles/library.css';
import './styles/approvals.css';
import './styles/focus.css';
import './styles/phone.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
