import { NextFunction, Request, Response } from 'express';

function getBasicUsers(): Record<string, { password: string; role: string }> {
  return {
    rhizome: {
      password: process.env.RHIZOME_PASSWORD || '',
      role: 'rhizome',
    },
    demo: {
      password: process.env.DEMO_PASSWORD || '',
      role: 'demo',
    },
  };
}

export async function validateOidcToken(token: string): Promise<{ name: string; role: string } | null> {
  const adminToken = process.env.OIDC_TEST_TOKEN;
  if (adminToken && token === adminToken) {
    return { name: 'admin', role: 'admin' };
  }

  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  if (!issuer || !audience) {
    return null;
  }

  try {
    const response = await fetch(`${issuer}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return null;
    }
    const userInfo = await response.json() as { sub?: string; name?: string };
    if (userInfo.sub) {
      return { name: userInfo.name || userInfo.sub, role: 'admin' };
    }
    return null;
  } catch {
    return null;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.set('WWW-Authenticate', 'Basic realm="fluxhaus", Bearer realm="fluxhaus"');
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    validateOidcToken(token).then((user) => {
      if (!user) {
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      req.user = user;
      next();
    }).catch(() => {
      res.status(401).json({ message: 'Unauthorized' });
    });
    return;
  }

  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    const username = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);
    const users = getBasicUsers();
    const userEntry = users[username];
    if (!userEntry || userEntry.password !== password) {
      res.set('WWW-Authenticate', 'Basic realm="fluxhaus"');
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    req.user = { name: username, role: userEntry.role };
    next();
    return;
  }

  res.set('WWW-Authenticate', 'Basic realm="fluxhaus", Bearer realm="fluxhaus"');
  res.status(401).json({ message: 'Unauthorized' });
}
