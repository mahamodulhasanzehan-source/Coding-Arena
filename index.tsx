import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'prismjs/themes/prism-tomorrow.css'; // Dark theme for code
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-markup'; // HTML

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);