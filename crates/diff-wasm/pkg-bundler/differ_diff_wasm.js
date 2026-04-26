/* @ts-self-types="./differ_diff_wasm.d.ts" */
import * as wasm from "./differ_diff_wasm_bg.wasm";
import { __wbg_set_wasm } from "./differ_diff_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    diff, diff_with_changes
} from "./differ_diff_wasm_bg.js";
