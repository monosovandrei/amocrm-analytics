import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DisplayBoard from './DisplayBoard';
import { WorkspaceInvite } from './WorkspaceOnboarding';
import './globals.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.location.hash.startsWith('#display') ? <DisplayBoard /> : window.location.hash.startsWith('#invite') ? <WorkspaceInvite /> : <App />}
  </React.StrictMode>,
);
