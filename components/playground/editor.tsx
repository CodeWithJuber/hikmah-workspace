'use client';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
export default function Editor({
  filename,
  value,
  onChange,
  readOnly = false,
  theme = 'light',
}: {
  filename: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** A prop rather than a context read, so both chat surfaces can use this.
   * The workspace passes its preference; /chat reads the attribute the layout
   * already stamps from the theme cookie. */
  theme?: 'light' | 'dark';
}) {
  const language = /\.tsx?$/.test(filename)
    ? javascript({ typescript: true, jsx: filename.endsWith('tsx') })
    : /\.jsx?$/.test(filename)
      ? javascript({ jsx: filename.endsWith('jsx') })
      : filename.endsWith('.html')
        ? html()
        : filename.endsWith('.css')
          ? css()
          : filename.endsWith('.json')
            ? json()
            : null;
  return (
    <CodeMirror
      value={value}
      editable={!readOnly}
      height="100%"
      theme={theme}
      extensions={[
        ...(language ? [language] : []),
        EditorView.contentAttributes.of({ 'aria-label': 'Code editor' }),
      ]}
      onChange={onChange}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        autocompletion: true,
      }}
      className="syntax-editor"
    />
  );
}
