declare global {
  namespace Express {
    interface Request {
      id?: string;
      workspaceId?: string;
      userId?: string;
    }
  }
}

export {};
