import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './error-boundary';

describe('ErrorBoundary', () => {
  test('renders children when no error', () => {
    const children = <div>Test Content</div>;
    const { getByText } = render(
      <ErrorBoundary fallback={(error, reset) => <div>Error</div>}>
        {children}
      </ErrorBoundary>
    );
    expect(getByText('Test Content')).toBeInTheDocument();
  });

  test('shows fallback when error occurs', () => {
    const TestComponent = () => {
      throw new Error('Test error');
    };

    const { getByText } = render(
      <ErrorBoundary fallback={(error, reset) => (
        <div>
          <h2>Error occurred</h2>
          <button onClick={reset}>Reset</button>
        </div>
      )}>
        <TestComponent />
      </ErrorBoundary>
    );

    expect(getByText('Error occurred')).toBeInTheDocument();
    expect(getByText('Reset')).toBeInTheDocument();
  });

  test('reset button clears error', () => {
    const TestComponent = () => {
      throw new Error('Test error');
    };

    const { getByText } = render(
      <ErrorBoundary fallback={(error, reset) => (
        <div>
          <button onClick={reset}>Reset</button>
        </div>
      )}>
        <TestComponent />
      </ErrorBoundary>
    );

    expect(getByText('Reset')).toBeInTheDocument();
    fireEvent.click(getByText('Reset'));
    expect(screen.queryByText('Reset')).not.toBeInTheDocument();
  });
});