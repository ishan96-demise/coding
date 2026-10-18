'use client';

import { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  fallback: (error: Error, resetError: () => void) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    // You could also log to an error reporting service here
  }

  public resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError && this.state.error) {
      return this.props.fallback(this.state.error, this.resetError);
    }

    return this.props.children;
  }
}