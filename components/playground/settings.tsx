'use client';
import { SecretsSettings } from './secrets-settings';
import Link from 'next/link';
import { SlidersHorizontal, Database, Sun, Moon, Download, Upload, KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { usePlayground } from './context';
import { errorMessage, downloadJson } from './common';
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
        <Button variant="outline" asChild>
          <Link href="/chat?settings=connection">Model connection & chat preferences</Link>
        </Button>
        <Tabs defaultValue="preferences" className="settings-tabs">
          <TabsList className="settings-tabs-list">
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
                  <Sun size={20} />
                  Light
                </Button>
                <Button
                  variant={preferences.theme === 'dark' ? 'default' : 'outline'}
                  onClick={() => setPreferences((p) => ({ ...p, theme: 'dark' }))}
                >
                  <Moon size={20} />
                  Dark
                </Button>
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
