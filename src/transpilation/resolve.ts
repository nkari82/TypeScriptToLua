import * as path from "path";
import * as resolve from "enhanced-resolve";
import * as ts from "typescript";
import * as fs from "fs";
import { EmitHost, ProcessedFile } from "./utils";
import { SourceNode } from "source-map";
import { getEmitPathRelativeToOutDir, getProjectRoot, getSourceDir } from "./transpiler";
import { formatPathToLuaPath, normalizeSlashes, trimExtension } from "../utils";
import { couldNotReadDependency, couldNotResolveRequire } from "./diagnostics";
import { BuildMode, CompilerOptions } from "../CompilerOptions";

const resolver = resolve.ResolverFactory.createResolver({
    extensions: [".lua"],
    enforceExtension: true, // Resolved file must be a lua file
    fileSystem: { ...new resolve.CachedInputFileSystem(fs) },
    useSyncFileSystemCalls: true,
    symlinks: false, // Do not resolve symlinks to their original paths (that breaks node_modules detection)
});

interface ResolutionResult {
    resolvedFiles: ProcessedFile[];
    diagnostics: ts.Diagnostic[];
}

class ResolutionContext {
    private noResolvePaths: Set<string>;

    public diagnostics: ts.Diagnostic[] = [];
    public resolvedFiles = new Map<string, ProcessedFile>();

    constructor(
        public readonly program: ts.Program,
        public readonly options: CompilerOptions,
        private readonly emitHost: EmitHost
    ) {
        this.noResolvePaths = new Set(options.noResolvePaths);
    }

    public addAndResolveDependencies(file: ProcessedFile): void {
        if (this.resolvedFiles.has(file.fileName)) return;
        this.resolvedFiles.set(file.fileName, file);

        for (const required of findRequiredPaths(file.code)) {
            // Do not resolve noResolution paths
            if (required.startsWith("@NoResolution:")) {
                // Remove @NoResolution prefix if not building in library mode
                if (!isBuildModeLibrary(this.program)) {
                    const path = required.replace("@NoResolution:", "");
                    replaceRequireInCode(file, required, path);
                    replaceRequireInSourceMap(file, required, path);
                }

                // Skip
                continue;
            }
            // Try to resolve the import starting from the directory `file` is in
            this.resolveImport(file, required);
        }
    }

    public resolveImport(file: ProcessedFile, required: string): void {
        // Do no resolve lualib - always use the lualib of the application entry point, not the lualib from external packages
        if (required === "lualib_bundle") {
            this.resolvedFiles.set("lualib_bundle", { fileName: "lualib_bundle", code: "" });
            return;
        }

        if (this.noResolvePaths.has(required)) {
            if (this.options.tstlVerbose) {
                console.log(`Skipping module resolution of ${required} as it is in the tsconfig noResolvePaths.`);
            }
            return;
        }

        const dependencyPath = this.resolveDependencyPath(file, required);
        if (!dependencyPath) return this.couldNotResolveImport(required, file);

        if (this.options.tstlVerbose) {
            console.log(`Resolved ${required} to ${normalizeSlashes(dependencyPath)}`);
        }

        this.processDependency(dependencyPath);
        // Figure out resolved require path and dependency output path
        if (shouldRewriteRequires(dependencyPath, this.program)) {
            const resolvedRequire = getEmitPathRelativeToOutDir(dependencyPath, this.program);
            replaceRequireInCode(file, required, resolvedRequire);
            replaceRequireInSourceMap(file, required, resolvedRequire);
        }
    }

    public processedDependencies = new Set<string>();

    private processDependency(dependencyPath: string): void {
        if (this.processedDependencies.has(dependencyPath)) return;
        this.processedDependencies.add(dependencyPath);

        if (!shouldIncludeDependency(dependencyPath, this.program)) return;

        // If dependency is not part of project, add dependency to output and resolve its dependencies recursively
        const dependencyContent = this.emitHost.readFile(dependencyPath);
        if (dependencyContent === undefined) {
            this.diagnostics.push(couldNotReadDependency(dependencyPath));
            return;
        }

        const dependency = {
            fileName: dependencyPath,
            code: dependencyContent,
        };
        this.addAndResolveDependencies(dependency);
    }

    private couldNotResolveImport(required: string, file: ProcessedFile): void {
        const fallbackRequire = fallbackResolve(required, getSourceDir(this.program), path.dirname(file.fileName));
        replaceRequireInCode(file, required, fallbackRequire);
        replaceRequireInSourceMap(file, required, fallbackRequire);

        this.diagnostics.push(
            couldNotResolveRequire(required, path.relative(getProjectRoot(this.program), file.fileName))
        );
    }

    private resolveDependencyPath(requiringFile: ProcessedFile, dependency: string): string | undefined {
        const fileDirectory = path.dirname(requiringFile.fileName);
        if (this.options.tstlVerbose) {
            console.log(`Resolving "${dependency}" from ${normalizeSlashes(requiringFile.fileName)}`);
        }

        const requiredFromLuaFile = requiringFile.fileName.endsWith(".lua");
        const dependencyPath = requiredFromLuaFile ? luaRequireToPath(dependency) : dependency;

        if (requiredFromLuaFile && isNodeModulesFile(requiringFile.fileName)) {
            // If requiring file is in lua module, try to resolve sibling in that file first
            const resolvedNodeModulesFile = this.resolveLuaDependencyPathFromNodeModules(requiringFile, dependencyPath);
            if (resolvedNodeModulesFile) return resolvedNodeModulesFile;
        }

        // Check if the import is relative
        const isRelative = ["/", "./", "../"].some(p => dependency.startsWith(p));

        // If the import is relative, always resolve it relative to the requiring file
        // If the import is not relative, resolve it relative to options.baseUrl if it is set
        const relativeTo = isRelative ? fileDirectory : this.options.baseUrl ?? fileDirectory;

        // Check if file is a file in the project
        const resolvedPath = path.join(relativeTo, dependencyPath);
        const fileFromPath = this.getFileFromPath(resolvedPath);
        if (fileFromPath) return fileFromPath;

        if (this.options.paths && this.options.baseUrl) {
            // If no file found yet and paths are present, try to find project file via paths mappings
            const fileFromPaths = this.tryGetModuleNameFromPaths(
                dependencyPath,
                this.options.paths,
                this.options.baseUrl
            );
            if (fileFromPaths) return fileFromPaths;
        }

        // Not a TS file in our project sources, use resolver to check if we can find dependency
        try {
            const resolveResult = resolver.resolveSync({}, fileDirectory, dependencyPath);
            if (resolveResult) return resolveResult;
        } catch (e) {
            // resolveSync errors if it fails to resolve
        }

        return undefined;
    }

    private resolveLuaDependencyPathFromNodeModules(
        requiringFile: ProcessedFile,
        dependency: string
    ): string | undefined {
        // We don't know for sure where the lua root is, so guess it is at package root
        const splitPath = path.normalize(requiringFile.fileName).split(path.sep);
        let packageRootIndex = splitPath.lastIndexOf("node_modules") + 2;
        let packageRoot = splitPath.slice(0, packageRootIndex).join(path.sep);

        while (packageRootIndex < splitPath.length) {
            // Try to find lua file relative to currently guessed Lua root
            const resolvedPath = path.join(packageRoot, dependency);
            const fileFromPath = this.getFileFromPath(resolvedPath);
            if (fileFromPath) {
                return fileFromPath;
            } else {
                // Did not find file at current root, try again one directory deeper
                packageRoot = path.join(packageRoot, splitPath[packageRootIndex++]);
            }
        }

        return undefined;
    }

    // value is false if already searched but not found
    private pathToFile = new Map<string, string | false>();

    private getFileFromPath(resolvedPath: string): string | undefined {
        const existingFile = this.pathToFile.get(resolvedPath);
        if (existingFile) return existingFile;
        if (existingFile === false) return undefined;

        const file = this.searchForFileFromPath(resolvedPath);
        this.pathToFile.set(resolvedPath, file ?? false);
        return file;
    }

    private searchForFileFromPath(resolvedPath: string): string | undefined {
        const possibleProjectFiles = [
            resolvedPath, // JSON files need their extension as part of the import path, caught by this branch,
            resolvedPath + ".ts", // Regular ts file
            path.join(resolvedPath, "index.ts"), // Index ts file,
            resolvedPath + ".tsx", // tsx file
            path.join(resolvedPath, "index.tsx"), // tsx index
        ];

        for (const possibleFile of possibleProjectFiles) {
            if (isProjectFile(possibleFile, this.program)) {
                return possibleFile;
            }
        }

        // Check if this is a lua file in the project sources
        const possibleLuaProjectFiles = [
            resolvedPath + ".lua", // lua file in sources
            path.join(resolvedPath, "index.lua"), // lua index file in sources
            path.join(resolvedPath, "init.lua"), // lua looks for <require>/init.lua if it cannot find <require>.lua
        ];
        for (const possibleFile of possibleLuaProjectFiles) {
            if (this.emitHost.fileExists(possibleFile)) {
                return possibleFile;
            }
        }
    }

    // Taken from TS and modified: https://github.com/microsoft/TypeScript/blob/88a1e3a1dd8d2d86e844ff1c16d5f041cebcfdb9/src/compiler/moduleSpecifiers.ts#L562
    private tryGetModuleNameFromPaths(relativeToBaseUrl: string, paths: ts.MapLike<string[]>, baseUrl: string) {
        const relativeImport = removeTrailingDirectorySeparator(normalizeSlashes(relativeToBaseUrl));
        for (const [importPattern, targetPatterns] of Object.entries(paths)) {
            const pattern = removeFileExtension(normalizeSlashes(importPattern));
            const indexOfStar = pattern.indexOf("*");
            if (indexOfStar !== -1) {
                // Try to match <prefix>*<suffix> to relativeImport
                const prefix = pattern.substring(0, indexOfStar);
                const suffix = pattern.substring(indexOfStar + 1);
                if (
                    (relativeImport.length >= prefix.length + suffix.length &&
                        relativeImport.startsWith(prefix) &&
                        relativeImport.endsWith(suffix)) ||
                    (!suffix && relativeImport === removeTrailingDirectorySeparator(prefix))
                ) {
                    // If import matches <prefix>*<suffix>, extract the matched * path
                    const matchedStar = relativeImport.substring(prefix.length, relativeImport.length - suffix.length);
                    // Try to resolve to the target patterns with filled in * pattern
                    for (const target of targetPatterns) {
                        const file = this.getFileFromPath(path.join(baseUrl, target.replace("*", matchedStar)));
                        if (file) return file;
                    }
                }
            } else if (pattern === relativeImport) {
                // If there is no * pattern, check for exact matches and try those targets
                for (const target of targetPatterns) {
                    const file = this.getFileFromPath(path.join(baseUrl, target));
                    if (file) return file;
                }
            }
        }
    }
}

export function resolveDependencies(program: ts.Program, files: ProcessedFile[], emitHost: EmitHost): ResolutionResult {
    const options = program.getCompilerOptions() as CompilerOptions;

    const resolutionContext = new ResolutionContext(program, options, emitHost);

    // Resolve dependencies for all processed files
    for (const file of files) {
        if (options.tstlVerbose) {
            console.log(`Resolving dependencies for ${normalizeSlashes(file.fileName)}`);
        }
        resolutionContext.addAndResolveDependencies(file);
    }

    return { resolvedFiles: [...resolutionContext.resolvedFiles.values()], diagnostics: resolutionContext.diagnostics };
}

function shouldRewriteRequires(resolvedDependency: string, program: ts.Program) {
    return !isBuildModeLibrary(program) || !isNodeModulesFile(resolvedDependency);
}

function shouldIncludeDependency(resolvedDependency: string, program: ts.Program) {
    // Never include lua files (again) that are transpiled from project sources
    if (hasSourceFileInProject(resolvedDependency, program)) return false;
    // Always include lua files not in node_modules (internal lua sources)
    if (!isNodeModulesFile(resolvedDependency)) return true;
    // Only include node_modules files if not in library mode
    return !isBuildModeLibrary(program);
}

function isBuildModeLibrary(program: ts.Program) {
    return program.getCompilerOptions().buildMode === BuildMode.Library;
}

function findRequiredPaths(code: string): string[] {
    // Find all require("<path>") paths in a lua code string
    const paths: string[] = [];
    const pattern = /(^|\s|;|=|\()require\("(.+?)"\)/g;
    // eslint-disable-next-line @typescript-eslint/ban-types
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code))) {
        paths.push(match[2]);
    }

    return paths;
}

function replaceRequireInCode(file: ProcessedFile, originalRequire: string, newRequire: string): void {
    const requirePath = formatPathToLuaPath(newRequire.replace(".lua", ""));

    // Escape special characters to prevent the regex from breaking...
    const escapedRequire = originalRequire.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

    file.code = file.code.replace(
        new RegExp(`(^|\\s|;|=|\\()require\\("${escapedRequire}"\\)`),
        `$1require("${requirePath}")`
    );
}

function replaceRequireInSourceMap(file: ProcessedFile, originalRequire: string, newRequire: string): void {
    const requirePath = formatPathToLuaPath(newRequire.replace(".lua", ""));
    if (file.sourceMapNode) {
        replaceInSourceMap(file.sourceMapNode, file.sourceMapNode, `"${originalRequire}"`, `"${requirePath}"`);
    }
}

function replaceInSourceMap(node: SourceNode, parent: SourceNode, require: string, resolvedRequire: string): boolean {
    if ((!node.children || node.children.length === 0) && node.toString() === require) {
        parent.children = [new SourceNode(node.line, node.column, node.source, [resolvedRequire])];
        return true; // Stop after finding the first occurrence
    }

    if (node.children) {
        for (const c of node.children) {
            if (replaceInSourceMap(c, node, require, resolvedRequire)) {
                return true; // Occurrence found in one of the children
            }
        }
    }

    return false; // Did not find the require
}

function isNodeModulesFile(filePath: string): boolean {
    return path
        .normalize(filePath)
        .split(path.sep)
        .some(p => p === "node_modules");
}

function isProjectFile(file: string, program: ts.Program): boolean {
    return program.getSourceFile(file) !== undefined;
}

function hasSourceFileInProject(filePath: string, program: ts.Program) {
    const pathWithoutExtension = trimExtension(filePath);
    return (
        isProjectFile(pathWithoutExtension + ".ts", program) ||
        isProjectFile(pathWithoutExtension + ".tsx", program) ||
        isProjectFile(pathWithoutExtension + ".json", program)
    );
}

// Transform an import path to a lua require that is probably not correct, but can be used as fallback when regular resolution fails
function fallbackResolve(required: string, sourceRootDir: string, fileDir: string): string {
    return formatPathToLuaPath(
        path
            .normalize(path.join(path.relative(sourceRootDir, fileDir), required))
            .split(path.sep)
            .filter(s => s !== "." && s !== "..")
            .join(path.sep)
    );
}

function luaRequireToPath(requirePath: string): string {
    return requirePath.replace(/\./g, path.sep);
}

function removeFileExtension(path: string) {
    return path.includes(".") ? trimExtension(path) : path;
}

function removeTrailingDirectorySeparator(path: string) {
    return path.endsWith("/") || path.endsWith("\\") ? path.substring(0, -1) : path;
}
