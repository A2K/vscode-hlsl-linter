'use strict';


import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as tempfile from 'tempfile';
import * as path from 'path';


export interface ITask<T> {
    (): T;
}

export class Throttler<T> {

    private activePromise: Promise<T> | null;
    private queuedPromise: Promise<T> | null;
    private queuedPromiseFactory: ITask<Promise<T>> | null;

    constructor() {
        this.activePromise = null;
        this.queuedPromise = null;
        this.queuedPromiseFactory = null;
    }

    public queue(promiseFactory: ITask<Promise<T>>): Promise<T> {
        if (this.activePromise) {
            this.queuedPromiseFactory = promiseFactory;

            if (!this.queuedPromise) {
                var onComplete = () => {
                    this.queuedPromise = null;

                    if (!this.queuedPromiseFactory) {
                        return new Promise<T>((resolve, reject) => {
                            resolve();
                        });
                    }

                    var result = this.queue(this.queuedPromiseFactory);
                    this.queuedPromiseFactory = null;

                    return result;
                };

                this.queuedPromise = new Promise<T>((resolve, reject) => {
                    if (this.activePromise) {
                        this.activePromise.then(onComplete, onComplete).then(resolve);
                    }
                });
            }

            return new Promise<T>((resolve, reject) => {
                if (this.queuedPromise) {
                    this.queuedPromise.then(resolve, reject);
                }
            });
        }

        this.activePromise = promiseFactory();

        return new Promise<T>((resolve, reject) => {
            if (this.activePromise) {
                this.activePromise.then((result: T) => {
                    this.activePromise = null;
                    resolve(result);
                }, (err: any) => {
                    this.activePromise = null;
                    reject(err);
                });
            }
        });
    }
}

export class Delayer<T> {

    public defaultDelay: number;
    private timeout: NodeJS.Timer | null;
    private completionPromise: Promise<T> | null;
    private onResolve: ((value: T | Thenable<T> | undefined) => void) | null;
    private task: ITask<T> | null;

    constructor(defaultDelay: number) {
        this.defaultDelay = defaultDelay;
        this.timeout = null;
        this.completionPromise = null;
        this.onResolve = null;
        this.task = null;
    }

    public trigger(task: ITask<T>, delay: number = this.defaultDelay): Promise<T> {
        this.task = task;
        this.cancelTimeout();

        if (!this.completionPromise) {
            this.completionPromise = new Promise<T>((resolve, reject) => {
                this.onResolve = resolve;
            }).then(() => {
                this.completionPromise = null;
                this.onResolve = null;

                if (this.task === null) {
                    return new Promise<T>((resolve, reject) => {
                        resolve();
                    });
                }
                var result = this.task();
                this.task = null;

                return result;
            });
        }

        this.timeout = setTimeout(() => {
            this.timeout = null;
            if (this.onResolve) {
                this.onResolve(undefined);
            }
        }, delay);

        return this.completionPromise;
    }

    public isTriggered(): boolean {
        return this.timeout !== null;
    }

    public cancel(): void {
        this.cancelTimeout();

        if (this.completionPromise) {
            this.completionPromise = null;
        }
    }

    private cancelTimeout(): void {
        if (this.timeout !== null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }
}

/**
 * A helper to delay execution of a task that is being requested often, while
 * preventing accumulation of consecutive executions, while the task runs.
 *
 * Simply combine the two mail man strategies from the Throttler and Delayer
 * helpers, for an analogy.
 */
export class ThrottledDelayer<T> extends Delayer<Promise<T>> {

    private throttler: Throttler<T>;

    constructor(defaultDelay: number) {
        super(defaultDelay);

        this.throttler = new Throttler();
    }

    public trigger(promiseFactory: ITask<Promise<T>>, delay?: number): Promise<Promise<T>> {
        return super.trigger(() => this.throttler.queue(promiseFactory), delay);
    }
}

enum RunTrigger {
    onSave,
    onType,
    never
}

namespace RunTrigger {
    'use strict';
    export let strings = {
        onSave: 'onSave',
        onType: 'onType',
        never: 'never'
    };
    export let from = function (value: string): RunTrigger {
        if (value === 'onSave') {
            return RunTrigger.onSave;
        } else if (value === 'onType') {
            return RunTrigger.onType;
        } else {
            return RunTrigger.never;
        }
    };
}

class CompilerOutputParser {

    private data: string = "";
    private filename: string;
    private document: vscode.TextDocument;

    private diagnostics: vscode.Diagnostic[] = [];

    private lineOffset: number = 0;

    constructor(filename_: string, document_: vscode.TextDocument) {
        this.filename = filename_;
        this.document = document_;
    }

    public write(buffer: Buffer) {
        this.data += buffer.toString();
        var newlineIndex = -1;
        while ((newlineIndex = this.data.indexOf('\n')) > -1) {
            this.processLine(this.data.substr(0, newlineIndex));
            this.data = this.data.substr(newlineIndex + 1);
        }
    }

    private processLine(line: string) {

        if (!line.startsWith(this.filename)) {
            return;
        }

        let parts: string[] = line.substring(this.filename.length + 1).split(":");

        if (parts.length > 3) {
            let line: number = Math.max(0, parseInt(parts.shift() || '0') - 1 + this.lineOffset);
            let column: number = Math.max(0, parseInt(parts.shift() || '0') - 1);

            if (this.document.lineAt(line).text.match(/^.*\/\/\s*\@[Nn][Oo][Ll][Ii][Nn][Tt].*$/)) {
                return;
            }

            let severityStr: string = (parts.shift() || '').trimLeft();

            let severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Information;

            if (0 === severityStr.localeCompare('warning')) {
                severity = vscode.DiagnosticSeverity.Warning;
            }
            else if (0 === severityStr.localeCompare('error')) {
                severity = vscode.DiagnosticSeverity.Error;
            }
            else if (0 === severityStr.localeCompare('note')) {
                severity = vscode.DiagnosticSeverity.Hint;
            }

            let message: string = parts.join(':').trim();

            this.diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, column, line, column), message, severity));
        }
    }

    public getDiagnostics(): vscode.Diagnostic[] {
        return this.diagnostics;
    }

    public setLineOffset(value: number): void {
        this.lineOffset = value;
    }
}

export default class HLSLLintingProvider implements vscode.Disposable {

    private diagnosticCollection: vscode.DiagnosticCollection;

    private executable: string = "dxc";

    private executableNotFound: boolean = false;

    private trigger: RunTrigger = RunTrigger.onType;

    private includeDirs: string[] = [];

    private defaultArgs: string[] = [];

    private delayers: { [key: string]: ThrottledDelayer<void> } = {};

    private documentListener: vscode.Disposable = { dispose: () => { } };

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
    }

    public activate(subscriptions: vscode.Disposable[]): void {
        subscriptions.push(this);
        vscode.workspace.onDidChangeConfiguration(this.loadConfiguration, this, subscriptions);
        this.loadConfiguration();

        vscode.workspace.onDidOpenTextDocument(this.triggerLint, this, subscriptions);
        vscode.workspace.onDidCloseTextDocument((textDocument) => {
            this.diagnosticCollection.delete(textDocument.uri);
        }, null, subscriptions);

        vscode.workspace.textDocuments.forEach(this.triggerLint, this);
    }

    private triggerLint(textDocument: vscode.TextDocument): void {
        if (textDocument.languageId !== 'hlsl' || this.executableNotFound) {
            return;
        }

        if (this.trigger === RunTrigger.never) {
            console.log('HLSL-lint: RunTrigger is set to never');
            this.diagnosticCollection.delete(textDocument.uri);
            return;
        }

        let key = textDocument.uri.toString();
        let delayer = this.delayers[key];
        if (!delayer) {
            delayer = new ThrottledDelayer<void>(this.trigger === RunTrigger.onType ? 250 : 0);
            this.delayers[key] = delayer;
        }
        delayer.trigger(() => this.doLint(textDocument));
    }

    private doLint(textDocument: vscode.TextDocument): Promise<void> {

        return new Promise<void>((resolve, reject) => {

            let filename = tempfile('.hlsl');

            let cleanup = ((filename: string) => {
                fs.unlink(filename, (err: Error) => { });
            }).bind(this, filename);

            let text = textDocument.getText();
            if (textDocument.fileName.endsWith(".ush")) {
                text = text.replace(/#pragma\s+once[^\n]*\n/g, '//#pragma once\n');
            }

            let executable = this.executable || 'dxc';

            let decoder = new CompilerOutputParser(filename, textDocument);

            let options = vscode.workspace.rootPath ? { cwd: vscode.workspace.rootPath } : undefined;

            let args: string[] = Array.from(this.defaultArgs);
            /* [
                '-Od', // disable optimizations
                '-Ges' // enable strict mode
            ];
            */

            const re = /\/\/\s*INPUTS(?:\((\w+)\))?:\s*([^\n]+)\s*\n/g;
            //const re = /\/\/\s*INPUTS:\s*([^\n]+)\s*\n/g;

            var symbols: string[] = [];

            var predefined: { [key: string]: string } = {};

            var m;
            while (m = re.exec(text)) {

                if (m.length === 1) {
                    continue;
                }

                var typeName: string = 'float';

                if (m.length === 3 && typeof (m[1]) !== 'undefined') {
                    typeName = m[1];
                }

                function makeTypeContructor(typeName: string) {
                    if (typeof (typeName) === 'undefined') {
                        return '0';
                    }

                    const Constructors: { [key: string]: string } = {
                        'float': '0.0',
                        'float2': 'float2(0, 0)',
                        'float3': 'float3(0, 0, 0)',
                        'float4': 'float4(0, 0, 0, 0)',
                        'int': '0',
                        'int2': 'int2(0, 0)',
                        'int3': 'int3(0, 0, 0)',
                        'int4': 'int4(0, 0, 0, 0)'
                    };

                    if (typeName in Constructors) {
                        return Constructors[typeName];
                    }

                    return null;
                }

                ((m.length === 2) ? m[1] : m[2]).split(/\s*,\s*/).forEach((symbol: string) => {
                    symbol = symbol.trim();
                    var existingSymbol = symbols.find((s) => 0 === s.localeCompare(symbol));
                    if (typeof (existingSymbol) === 'undefined' || null === existingSymbol) {
                        symbols.push(symbol);
                        let typeConstructor = makeTypeContructor(typeName);
                        if (typeConstructor === null) {
                            predefined[symbol] = typeName;
                        }
                        else {
                            args.push('-D');
                            args.push(symbol + '=' + typeConstructor);
                        }
                    }
                });
            }

            args.push('-I');
            args.push(path.dirname(textDocument.fileName));

            
            this.includeDirs.forEach(includeDir => {
                args.push("-I");
                args.push(includeDir);
            });

            args.push(filename);

            var addedLines = 0;
            let prefix: string = "";
            Object.keys(predefined).forEach((key) => {
                prefix += predefined[key] + ' ' + key + ';\n';
                addedLines = addedLines + 1;
            });

            decoder.setLineOffset(-addedLines);

            text = prefix + text;

            fs.writeFile(filename, Buffer.from(text, 'utf8'), ((err: Error) => {

                if (err) {
                    console.log('error:', err);
                    cleanup();
                    return;
                }

                //console.log(`Starting "${executable} ${args.join(' ')}"`);

                let childProcess = cp.spawn(executable, args, options);
                childProcess.on('error', (error: Error) => {
                    console.error("Failed to start DXC:", error);
                    if (this.executableNotFound) {
                        console.error("DXC executable not found");
                        cleanup();
                        resolve();
                        return;
                    }
                    var message: string;
                    if ((<any>error).code === 'ENOENT') {
                        message = `Cannot lint the HLSL file. The 'dxc' program was not found. Use the 'hlsl.linter.executablePath' setting to configure the location of 'dxc'`;
                    } else {
                        message = error.message ? error.message : `Failed to run dxc using path: ${executable}. Reason is unknown.`;
                    }
                    console.log(message);
                    this.executableNotFound = true;
                    cleanup();
                    resolve();
                });
                if (childProcess.pid) {
                    childProcess.stderr.on('data', (data: Buffer) => {
                        decoder.write(data);
                    });
                    childProcess.stderr.on('end', () => {
                        let diagnostics: vscode.Diagnostic[] = decoder.getDiagnostics();
                        if (diagnostics.length) {
                            this.diagnosticCollection.set(textDocument.uri, diagnostics);
                        }
                        else {
                            this.diagnosticCollection.delete(textDocument.uri);
                        }
                        cleanup();
                        resolve();
                    });
                } else {
                    cleanup();
                    resolve();
                }
            }).bind(this));
        });
    }

    private loadConfiguration(): void {

        let section = vscode.workspace.getConfiguration('hlsl');

        if (section) {
            this.executable = section.get<string>('linter.executablePath', "D:\\Desktop\\DXC\\bin\\dxc.exe");
            this.trigger = RunTrigger.from(section.get<string>('linter.trigger', RunTrigger.strings.onType));
            this.includeDirs = section.get<string[]>('linter.includeDirs') || [];
            this.defaultArgs = section.get<string[]>('linter.defaultArgs') || [];
        }

        if (this.documentListener) {
            this.documentListener.dispose();
        }
        if (this.trigger === RunTrigger.onType) {
            this.documentListener = vscode.workspace.onDidChangeTextDocument((e) => {
                this.triggerLint(e.document);
            });
        } else if (this.trigger === RunTrigger.onSave) {
            this.documentListener = vscode.workspace.onDidSaveTextDocument(this.triggerLint, this);
        }
        // Configuration has changed. Reevaluate all documents.
        vscode.workspace.textDocuments.forEach(this.triggerLint, this);

    }

    public dispose() {

    }
}

export function activate(context: vscode.ExtensionContext): void {
    let linter = new HLSLLintingProvider();
    linter.activate(context.subscriptions);
}

export function deactivate() { }
