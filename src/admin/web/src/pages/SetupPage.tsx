import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { setupSchema } from '@shared/schemas';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSetup } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api';

export function SetupPage() {
  const navigate = useNavigate();
  const setup = useSetup();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = setupSchema.safeParse({ username, password });
    if (!parsed.success) {
      setError('Username must be 3+ chars and password 8+.');
      return;
    }
    try {
      await setup.mutateAsync(parsed.data);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'setup_closed') {
        setError('Setup is already complete. Sign in instead.');
        return;
      }
      setError('Could not create the first operator.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Welcome to SAM</CardTitle>
          <CardDescription>Create the first operator account</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={setup.isPending}>
              {setup.isPending ? 'Creating…' : 'Create operator'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
