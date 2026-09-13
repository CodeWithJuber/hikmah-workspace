'use client';
import { SecretsSettings } from './secrets-settings';
import Link from 'next/link';
import {
  Plug,
  SlidersHorizontal,
  Database,
  Sun,
  Moon,
  Download,
  Upload,
  KeyRound,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { usePlayground } from './context';
import { Choice, errorMessage, downloadJson } from './common';
import { toast } from 'sonner';
export function Settings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { session, importSession, storageMessage, preferences, setPreferences } = usePlayground();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog">
        <DialogHeader className="settings-heading">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Make this workspace work for you.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="connection" className="settings-tabs">
          <TabsList className="settings-tabs-list">
            <TabsTrigger value="connection">
              <Plug size={16} />
              Connection
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <KeyRound size={16} />
              Secrets
            </TabsTrigger>
            <TabsTrigger value="preferences">
              <SlidersHorizontal size={16} />
              Preferences
            </TabsTrigger>
            <TabsTrigger value="data">
              <Database size={16} />
              Your data
            </TabsTrigger>
          </TabsList>
          <div className="settings-scroll">
            {/* The Connection tab was here. It kept a provider key in React
                state labelled "Session only", which meant it survived until the
                tab reloaded and then did not — and it was one of five places in
                this app that could take a credential, three of which stored it
                nowhere. There is one now, in the chat's own settings, and it
                writes to the encrypted vault. */}
            <TabsContent value="connection">
              <div className="settings-section-title">
                <span className="step-number">1</span>
                <div>
                  <h3>Connect a provider</h3>
                  <p>Your provider, model and API key live with the chat now.</p>
                </div>
              </div>
              <p className="settings-moved">
                Open <Link href="/chat">the chat</Link> and choose{' '}
                <strong>Settings → Connection</strong>. A key saved there is encrypted before it is
                stored and never sent back to the page, which the field here could not promise.
              </p>
            </TabsContent>
            <TabsContent value="secrets">
              <SecretsSettings />
            </TabsContent>
            <TabsContent value="preferences">
              <h3>Appearance</h3>
              <div className="theme-options">
                <Button
                  variant={preferences.theme === 'light' ? 'default' : 'outline'}
                  onClick={() => setPreferences((p) => ({ ...p, theme: 'light' }))}
                >
                  <Sun size={19} />
                  Light
                </Button>
                <Button
                  variant={preferences.theme === 'dark' ? 'default' : 'outline'}
                  onClick={() => setPreferences((p) => ({ ...p, theme: 'dark' }))}
                >
                  <Moon size={19} />
                  Dark
                </Button>
              </div>
              <div className="separated">
                <Choice
                  label="Response style"
                  value={preferences.responseStyle}
                  onChange={(v) =>
                    setPreferences((p) => ({ ...p, responseStyle: v as typeof p.responseStyle }))
                  }
                  options={[
                    { value: 'concise', label: 'Concise' },
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'detailed', label: 'Detailed' },
                  ]}
                />
                <label className="setting-switch">
                  <div>
                    <strong>Enter to send</strong>
                    <span>Shift + Enter adds a new line. Ctrl/⌘ + Enter always sends.</span>
                  </div>
                  <Switch
                    checked={preferences.enterToSend}
                    onCheckedChange={(v) => setPreferences((p) => ({ ...p, enterToSend: v }))}
                  />
                </label>
              </div>
              <div className="field separated">
                <label htmlFor="custom-instructions">Your instructions</label>
                <Textarea
                  id="custom-instructions"
                  value={preferences.instructions}
                  onChange={(e) => setPreferences((p) => ({ ...p, instructions: e.target.value }))}
                  maxLength={4000}
                  placeholder="For example: Use simple English. For coding, prefer TypeScript and explain how to test."
                />
                <p className="small-note">
                  Applied to new requests. Your instructions are saved to your private workspace.
                </p>
              </div>
            </TabsContent>
            <TabsContent value="data">
              <h3>Your saved workspace</h3>
              <p className="muted">
                Conversations, knowledge, run checkpoints, files and preferences sync to your
                signed-in workspace. A device copy supports recovery. Session keys stay in browser
                memory. Saved secret values remain in encrypted server storage and are excluded from
                exports.
              </p>
              <div className="data-action">
                <Download size={24} />
                <div>
                  <strong>Export workspace session</strong>
                  <p>
                    Chats, files and preferences. Download generated media separately. No API keys.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => downloadJson(session(), 'hikmah-session.json')}
                >
                  Export
                </Button>
              </div>
              <div className="data-action">
                <Upload size={24} />
                <div>
                  <strong>Import workspace session</strong>
                  <p>Replaces the current workspace session. Export it first if needed.</p>
                </div>
              </div>
              <Input
                aria-label="Import session file"
                type="file"
                accept="application/json,.json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    try {
                      if (file.size > 20000000) throw Error('Choose a session file under 20 MB.');
                      importSession(await file.text());
                      toast.success('Session restored. Re-enter your provider key to connect.');
                      onOpenChange(false);
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }
                  e.target.value = '';
                }}
              />
              <p className="small-note separated">{storageMessage}</p>
            </TabsContent>
          </div>
        </Tabs>
        <footer className="settings-footer">
          <span>Changes save automatically</span>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
