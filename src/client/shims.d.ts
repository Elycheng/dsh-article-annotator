/**
 * Minimal ambient declarations for the browser half.
 *
 * The client bundle only requires the platform baseline module `react`; the
 * local build must not depend on @types/react being installed in this repo, so
 * the handful of React surface used here is declared by hand. JSX compiles to
 * `React.createElement` (classic runtime), so no jsx-runtime import appears in
 * the bundle.
 */

declare namespace JSX {
  interface Element {}
  interface ElementClass {
    render(): any
  }
  interface IntrinsicElements {
    [elementName: string]: any
  }
  interface ElementAttributesProperty {
    props: {}
  }
  interface ElementChildrenAttribute {
    children: {}
  }
}

declare module 'react' {
  export type ReactNode = any
  export type ReactElement = any
  export function createElement(type: any, props?: any, ...children: any[]): any
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void), dependencies?: any[]): void
  export function useMemo<T>(factory: () => T, dependencies: any[]): T
  export function useCallback<T extends (...args: any[]) => any>(callback: T, dependencies: any[]): T
  export function useRef<T>(initial: T): { current: T }
  export const Fragment: any
  const React: any
  export default React
}

interface Window {
  __ModuleLoader__: {
    load(definition: { id: string; factory: (require: (specifier: string) => any) => any }): void
  }
}
