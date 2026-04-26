/* tslint:disable */
/* eslint-disable */

export class DiffSession {
    free(): void;
    [Symbol.dispose](): void;
    diff(): any;
    diff_with_changes(): any;
    constructor();
    set_a(text: string): void;
    set_b(text: string): void;
}

export function diff(a: string, b: string): any;

export function diff_with_changes(a: string, b: string): any;
