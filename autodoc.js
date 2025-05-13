#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');
const marked = require('marked'); 
const { program } = require('commander');

program
  .option('--skip-uncommented', 'Skip abstracts and objects without comments')
  .option('-i, --input <directory>', 'Input directory containing parsed files', './.eoc/1-parse')
  .option('-o, --output <directory>', 'Output directory for generated documentation', './docs')
  .parse(process.argv);

const options = program.opts();

const inputDir = options.input;
const outputDir = options.output;

const markedOptions = {
    breaks: true,
    gfm: true,
    pedantic: false,
    mangle: false,
    headerIds: false
};
marked.setOptions(markedOptions);

const parser = new xml2js.Parser();
const globalProcessedAbstracts = new Set();

const packages = {};

async function readxmirFilesRecursively(dir) {
    let xmirFiles = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nestedFiles = await readxmirFilesRecursively(entryPath);
            xmirFiles = xmirFiles.concat(nestedFiles);
        } else if (entry.isFile() && entry.name.endsWith('.xmir')) {
            xmirFiles.push(entryPath);
        }
    }
    return xmirFiles;
}

async function parseXML(content) {
    return parser.parseStringPromise(content);
}

function extractComments(commentsXml) {
    return commentsXml?.map(comment => ({
        line: parseInt(comment.$.line, 10),
        text: comment._
    })) || [];
}

function buildLineToCommentMap(comments) {
    const map = {};
    comments.forEach(comment => {
        map[comment.line] = comment.text.trim();
    });
    return map;
}

function preprocessMarkdown(markdownText) {
    if (!markdownText) return '';
    const textWithProperNewlines = markdownText.replace(/\\n/g, '\n');
    return textWithProperNewlines.replace(/'''([\s\S]*?)'''/g, '\n```\n$1\n```\n');
}

function buildAbstracts(objects, lineToCommentMap, parentAbstract = null, abstracts = [], skipUncommented = false) {
    if (!objects) return abstracts;
    objects.forEach(o => {
        if (!o.$ || !o.$.line) return;
        const objectName = o.$.name || 'Unnamed';
        if (objectName === 'Unnamed' || objectName === '@' || objectName === 'λ') {
            return;
        }
        const objectLine = parseInt(o.$.line, 10);
        const objectComment = lineToCommentMap[objectLine] || '';
        if (skipUncommented && !objectComment) {
            console.log(`Skipping object '${objectName}' without comments.`);
            return;
        }

        const currentUniqueId = parentAbstract ? `${parentAbstract.uniqueId}_${objectName}` : objectName;

        const isRootObject = !parentAbstract;
        if (isRootObject) {
            if (globalProcessedAbstracts.has(currentUniqueId)) {
                return;
            }
            globalProcessedAbstracts.add(currentUniqueId);
            const abstract = {
                name: objectName,
                uniqueId: currentUniqueId,
                line: objectLine,
                pos: parseInt(o.$.pos, 10),
                comments: objectComment,
                parent: parentAbstract,
                childrenAbstracts: [],
                childObjects: [],
                base: o.$.base || '',
                isQuestion: o.$.name && o.$.name.includes('?')
            };
            abstracts.push(abstract);
            if (o.o && o.o.length > 0) {
                o.o.forEach(childObj => {
                    if (childObj.$ && childObj.$.name) {
                        const childName = childObj.$.name;
                        if (childName === 'Unnamed' || childName === '@' || childName === 'λ') {
                            return;
                        }
                        const childLine = parseInt(childObj.$.line, 10);
                        const childComment = lineToCommentMap[childLine] || '';
                        if (skipUncommented && !childComment) {
                            return;
                        }
                        if (childObj.o && childObj.o.length > 0) {
                            const nestedAbstracts = buildAbstracts([childObj], lineToCommentMap, abstract, [], skipUncommented);
                            if (nestedAbstracts && nestedAbstracts.length > 0) {
                                abstract.childrenAbstracts.push(...nestedAbstracts);
                            }
                        } else {
                            const obj = {
                                name: childName,
                                line: childLine,
                                pos: parseInt(childObj.$.pos, 10),
                                comments: childComment,
                                base: childObj.$.base || '',
                                isQuestion: childObj.$.name && childObj.$.name.includes('?')
                            };
                            abstract.childObjects.push(obj);
                        }
                    }
                });
                o.o.forEach(childObj => {
                    if (childObj.$ && childObj.$.name) {
                        const childName = childObj.$.name;
                        const childUniqueId = `${abstract.uniqueId}_${childName}`;
                        const isAlreadyProcessedAsAbstract = abstract.childrenAbstracts.some(a => a.uniqueId === childUniqueId);
                        const isAlreadyProcessedAsObject = abstract.childObjects.some(obj => obj.name === childName && !obj.uniqueId);
                        
                        if (!isAlreadyProcessedAsAbstract && !isAlreadyProcessedAsObject && childName !== 'Unnamed' && childName !== '@' && childName !== 'λ') {
                            const childLine = parseInt(childObj.$.line, 10);
                            const childComment = lineToCommentMap[childLine] || '';
                            if (!skipUncommented || childComment) {
                                const obj = {
                                    name: childName,
                                    line: childLine,
                                    pos: parseInt(childObj.$.pos, 10),
                                    comments: childComment,
                                    base: childObj.$.base || '',
                                    isQuestion: childName.includes('?')
                                };
                                abstract.childObjects.push(obj);
                            }
                        }
                    }
                });
            }
        } else {
            const obj = {
                name: objectName,
                line: objectLine,
                pos: parseInt(o.$.pos, 10),
                comments: objectComment,
                base: o.$.base || '',
                isQuestion: objectName.includes('?')
            };
            
            const hasSignificantChildren = o.o && o.o.some(child => 
                child.$ && child.$.name && 
                !['Unnamed', '@', 'λ'].includes(child.$.name) &&
                child.o && child.o.length > 0
            );

            if (hasSignificantChildren) {
                const childAbstract = {
                    name: objectName,
                    uniqueId: currentUniqueId,
                    line: objectLine,
                    pos: parseInt(o.$.pos, 10),
                    comments: objectComment,
                    parent: parentAbstract,
                    childrenAbstracts: [],
                    childObjects: [],
                    base: o.$.base || '',
                    isQuestion: objectName.includes('?')
                };
                buildAbstracts(o.o, lineToCommentMap, childAbstract, [], skipUncommented);
                parentAbstract.childrenAbstracts.push(childAbstract);
            } else {
                 if (parentAbstract.childObjects.filter(co => co.name === obj.name).length === 0) {
                    parentAbstract.childObjects.push(obj);
                 }
                if (o.o && o.o.length > 0) {
                    buildAbstracts(o.o, lineToCommentMap, parentAbstract, abstracts, skipUncommented);
                }
            }
        }
    });
    return abstracts;
}

function sanitizeFileName(name) {
    return name.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
}

function renderAbstract(abs) {
    const commentsHtml = abs.comments ? marked.parse(preprocessMarkdown(abs.comments)) : '';
    const descriptionSection = `
    <section class="description-section">
        <h3>
            <button class="collapsible" aria-expanded="true">
                Description
                <span class="icon">▼</span>
            </button>
        </h3>
        <div class="collapsible-content">
            ${abs.comments ? 
                `<div class="comments">${commentsHtml}</div>` : 
                '<div class="no-comments">No description</div>'
            }
        </div>
    </section>`;
    let childObjectsSection = '';
    if (abs.childObjects.length > 0) {
        childObjectsSection = `
        <section class="objects-section">
            <h3>
                <button class="collapsible collapsed" aria-expanded="false">
                    Objects of ${abs.name}
                    <span class="icon">►</span>
                </button>
            </h3>
            <div class="collapsible-content" style="display: none;">
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${abs.childObjects.map(obj => `
                            <tr>
                                <td>${obj.name}${obj.isQuestion ? ' (?)' : ''}</td>
                                <td class="table-description">${obj.comments ? marked.parse(preprocessMarkdown(obj.comments)) : 'No description'}</td>
                            </tr>`).join('\n')}
                    </tbody>
                </table>
            </div>
        </section>`;
    }
    let nestedAbstractsSection = '';
    if (abs.childrenAbstracts && abs.childrenAbstracts.length > 0) {
        nestedAbstractsSection = `
        <section class="nested-abstracts-section">
            <h3>
                <button class="collapsible collapsed" aria-expanded="false">
                    Nested Abstracts of ${abs.name}
                    <span class="icon">►</span>
                </button>
            </h3>
            <div class="collapsible-content" style="display: none;">
                <div class="nested-abstracts">
                    ${abs.childrenAbstracts.map(child => `
                        <div class="nested-abstract">
                            ${renderAbstract(child)}
                        </div>
                    `).join('\n')}
                </div>
            </div>
        </section>`;
    }
    return `
    <section class="abstract-section" id="${abs.uniqueId}">
        <h2>${abs.name}${abs.isQuestion ? ' (?)' : ''}</h2>
        ${descriptionSection}
        ${childObjectsSection}
        ${nestedAbstractsSection}
    </section>
    `;
}

function generatePackagePage(pkgName, pkgData, allPackages) {
    const packageParts = pkgName.split('.');
    const parentPackage = packageParts.length > 1 ? packageParts.slice(0, -1).join('.') : null;
    const childPackages = Object.keys(allPackages).filter(p => {
        return p.startsWith(pkgName + '.') && p.split('.').length === packageParts.length + 1;
    });
    const abstractsHtml = pkgData.abstracts.map(abs => renderAbstract(abs)).join('\n');
    const buildAbstractsTree = (abstracts) => {
        return abstracts.map(abs => `
            <li class="sidebar-item">
                <div class="sidebar-item-header">
                    <a href="#${encodeURIComponent(abs.uniqueId)}" class="sidebar-link">${abs.name}</a>
                    ${abs.childrenAbstracts && abs.childrenAbstracts.length > 0 ? 
                        `<button class="sidebar-toggle" aria-label="Toggle nested items">
                            <span class="toggle-icon">►</span>
                        </button>` : ''}
                </div>
                ${abs.childrenAbstracts && abs.childrenAbstracts.length > 0 ? 
                    `<ul class="sidebar-nested-list" style="display: none;">
                        ${buildAbstractsTree(abs.childrenAbstracts)}
                    </ul>` : ''}
            </li>
        `).join('');
    };
    const packageTreeHtml = `
        <div class="sidebar-section">
            <h3 class="sidebar-title">Packages</h3>
            <ul class="sidebar-list">
                <li class="sidebar-item"><a href="packages.html" class="sidebar-link">All Packages</a></li>
                ${parentPackage ? `<li class="sidebar-item"><a href="package_${sanitizeFileName(parentPackage)}.html" class="sidebar-link">↑ Parent: ${parentPackage}</a></li>` : ''}
                ${childPackages.map(cp => 
                    `<li class="sidebar-item"><a href="package_${sanitizeFileName(cp)}.html" class="sidebar-link">↳ ${cp.split('.').pop()}</a></li>`
                ).join('')}
            </ul>
        </div>
    `;
    const abstractsTreeHtml = `
        <div class="sidebar-section">
            <h3 class="sidebar-title">Abstracts in this Package</h3>
            <ul class="sidebar-list">
                ${buildAbstractsTree(pkgData.abstracts)}
            </ul>
        </div>
    `;
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Package: ${pkgName}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="sidebar" id="doc-sidebar">
        <div class="sidebar-header">
            <h2>Navigation</h2>
        </div>
        ${packageTreeHtml}
        ${abstractsTreeHtml}
    </div>
    
    <div class="content-wrapper">
        <header>
            <div class="header-content">
                <h1>Package: ${pkgName || '(default)'}</h1>
                ${generateSearchBarHTML()}
            </div>
        </header>
        
        <nav class="breadcrumb-nav">
            <p><a href="packages.html">All Packages</a></p>
            ${parentPackage ? `<p>Parent Package: <a href="package_${sanitizeFileName(parentPackage)}.html">${parentPackage}</a></p>` : ''}
            ${childPackages.length > 0 ? `
            <div class="child-packages">
                <h2>
                    <button class="collapsible" aria-expanded="true">
                        Child Packages
                        <span class="icon">▼</span>
                    </button>
                </h2>
                <div class="collapsible-content">
                    <ul>${childPackages.map(cp => `<li><a href="package_${sanitizeFileName(cp)}.html">${cp}</a></li>`).join('\n')}</ul>
                </div>
            </div>` : ''}
        </nav>
        
        ${pkgData.abstracts.length > 0 ? 
            `<h2>Abstracts in this Package</h2>
            ${abstractsHtml}` : 
            '<p>No abstracts found in this package</p>'
        }
        
        <footer>
            <p>Generated on ${new Date().toLocaleString()}</p>
        </footer>
    </div>
    
    <script src="search.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const collapsibles = document.querySelectorAll('.collapsible');
            collapsibles.forEach(collapsible => {
                collapsible.addEventListener('click', function() {
                    this.classList.toggle('collapsed');
                    const isExpanded = this.getAttribute('aria-expanded') === 'true';
                    this.setAttribute('aria-expanded', !isExpanded);
                    const icon = this.querySelector('.icon');
                    if (icon) {
                        icon.textContent = isExpanded ? '►' : '▼';
                    }
                    const content = this.parentElement.nextElementSibling;
                    if (content && content.classList.contains('collapsible-content')) {
                        content.style.display = isExpanded ? 'none' : 'block';
                    }
                });
            });
            
            const sidebarToggles = document.querySelectorAll('.sidebar-toggle');
            sidebarToggles.forEach(toggle => {
                toggle.addEventListener('click', function(e) {
                    e.preventDefault();
                    const nestedList = this.parentElement.nextElementSibling;
                    const icon = this.querySelector('.toggle-icon');
                    if (nestedList.style.display === 'none' || !nestedList.style.display) {
                        nestedList.style.display = 'block';
                        icon.textContent = '▼';
                    } else {
                        nestedList.style.display = 'none';
                        icon.textContent = '►';
                    }
                });
            });
            const sidebarLinks = document.querySelectorAll('.sidebar-link');
            sidebarLinks.forEach(link => {
                link.addEventListener('click', function(e) {
                    let currentItem = this.closest('li.sidebar-item');
                    while (currentItem) {
                        const parentNestedList = currentItem.closest('ul.sidebar-nested-list');
                        if (parentNestedList) {
                            parentNestedList.style.display = 'block';
                            const header = parentNestedList.previousElementSibling;
                            if (header && header.classList.contains('sidebar-item-header')) {
                                const toggleIcon = header.querySelector('.sidebar-toggle .toggle-icon');
                                if (toggleIcon) {
                                    toggleIcon.textContent = '▼';
                                }
                            }
                            currentItem = parentNestedList.closest('li.sidebar-item');
                        } else {
                            currentItem = null; 
                        }
                    }
                    const href = this.getAttribute('href');
                    if (href.startsWith('#')) {
                        e.preventDefault();
                        const targetId = decodeURIComponent(href.substring(1));
                        if (typeof window.expandAndScrollToTarget === 'function') {
                            window.expandAndScrollToTarget(targetId, true, true, false);
                        }
                    }
                });
            });
            const abstractSections = document.querySelectorAll('.abstract-section');

            function highlightCurrentSection() {
                const sections = document.querySelectorAll('.abstract-section');
                const sidebarLinks = document.querySelectorAll('.sidebar-link');
                let currentSectionId = '';
                sections.forEach(section => {
                    const rect = section.getBoundingClientRect();
                    if (rect.top <= 100 && rect.bottom >= 100) {
                        currentSectionId = section.id;
                    }
                });
                sidebarLinks.forEach(link => {
                    link.classList.remove('active');
                    if (decodeURIComponent(link.getAttribute('href')) === '#' + currentSectionId) {
                        link.classList.add('active');
                        let parent = link.closest('.sidebar-nested-list');
                        while (parent) {
                            parent.style.display = 'block';
                            const toggleButton = parent.previousElementSibling.querySelector('.sidebar-toggle .toggle-icon');
                            if (toggleButton) {
                                toggleButton.textContent = '▼';
                            }
                            parent = parent.parentElement.closest('.sidebar-nested-list');
                        }
                    }
                });
            }
            window.addEventListener('scroll', highlightCurrentSection);
            
            if (typeof window.expandAndScrollToTarget === 'function') {
                const sessionTarget = sessionStorage.getItem('expandTarget');
                if (sessionTarget) {
                    const isObject = sessionStorage.getItem('expandTargetType') === 'object';
                    window.expandAndScrollToTarget(sessionTarget, true, false, isObject);
                    sessionStorage.removeItem('expandTarget');
                    if (isObject) sessionStorage.removeItem('expandTargetType');
                } else if (window.location.hash && window.location.hash.length > 1) {
                    window.expandAndScrollToTarget(decodeURIComponent(window.location.hash.substring(1)), true, false, false);
                }
            }
        });
    </script>
</body>
</html>`;
    return html;
}

function generatePackagesPage(allPackages) {
    const packageNames = Object.keys(allPackages).sort();
    const packageTree = {};
    packageNames.forEach(p => {
        const parts = p.split('.');
        let current = packageTree;
        parts.forEach((part, i) => {
            if (!current[part]) {
                current[part] = {
                    fullName: parts.slice(0, i + 1).join('.'),
                    children: {}
                };
            }
            current = current[part].children;
        });
    });
    const renderPackageTree = (tree) => {
        return Object.keys(tree).map(key => {
            const node = tree[key];
            const hasChildren = Object.keys(node.children).length > 0;
            return `<li class="sidebar-item">
                <div class="sidebar-item-header">
                    <a href="package_${sanitizeFileName(node.fullName || key)}.html" class="sidebar-link">${key}</a>
                    ${hasChildren ? 
                        `<button class="sidebar-toggle" aria-label="Toggle nested packages">
                            <span class="toggle-icon">►</span>` : ''}
                </div>
                ${hasChildren ? 
                    `<ul class="sidebar-nested-list" style="display: none;">
                        ${renderPackageTree(node.children)}
                     </ul>` : ''}
            </li>`;
        }).join('');
    };
    const sidebarHtml = `
    <div class="sidebar-section">
        <h3 class="sidebar-title">All Packages</h3>
        <ul class="sidebar-list">
            ${renderPackageTree(packageTree)}
        </ul>
    </div>`;
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Packages Catalog</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="sidebar" id="doc-sidebar">
        <div class="sidebar-header">
            <h2>Navigation</h2>
        </div>
        ${sidebarHtml}
    </div>

    <div class="content-wrapper">
        <header>
            <div class="header-content">
                <h1>Packages Catalog</h1>
                ${generateSearchBarHTML()}
            </div>
        </header>
        <section class="package-listing">
            <ul class="package-list">
                ${packageNames.map(p => `<li><a href="package_${sanitizeFileName(p)}.html">${p || '(default)'}</a> <span class="object-count">${allPackages[p].abstracts.length} abstracts</span></li>`).join('\n')}
            </ul>
        </section>
        <footer>
            <p>Generated on ${new Date().toLocaleString()}</p>
        </footer>
    </div>
    
    <script src="search.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const sidebarToggles = document.querySelectorAll('.sidebar-toggle');
            sidebarToggles.forEach(toggle => {
                toggle.addEventListener('click', function(e) {
                    e.preventDefault();
                    const parent = this.parentElement;
                    const nestedList = parent.nextElementSibling;
                    const icon = this.querySelector('.toggle-icon');
                    if (nestedList.style.display === 'none' || !nestedList.style.display) {
                        nestedList.style.display = 'block';
                        icon.textContent = '▼';
                    } else {
                        nestedList.style.display = 'none';
                        icon.textContent = '►';
                    }
                });
            });
        });
    </script>
</body>
</html>`;
    return html;
}

function collectSearchableItems(allPackages) {
    const searchData = {
        abstracts: [],
        packages: []
    };
    Object.keys(allPackages).forEach(pkgName => {
        searchData.packages.push({
            name: pkgName || '(default)',
            url: `package_${sanitizeFileName(pkgName)}.html`
        });
        allPackages[pkgName].abstracts.forEach(abstract => {
            searchData.abstracts.push({
                name: abstract.name,
                type: 'abstract',
                package: pkgName || '(default)',
                url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(abstract.uniqueId)}`
            });

            if (abstract.childObjects && abstract.childObjects.length > 0) {
                abstract.childObjects.forEach(obj => {
                    searchData.abstracts.push({
                        name: obj.name,
                        type: 'object',
                        package: pkgName || '(default)',
                        url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(abstract.uniqueId)}`,
                        parentName: abstract.name
                    });
                });
            }

            function addNestedAbstractsAndObjects(parentAbstract) {
                if (parentAbstract.childrenAbstracts && parentAbstract.childrenAbstracts.length > 0) {
                    parentAbstract.childrenAbstracts.forEach(childAbstract => {
                        searchData.abstracts.push({
                            name: childAbstract.name,
                            type: 'abstract',
                            package: pkgName || '(default)',
                            url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(childAbstract.uniqueId)}`,
                            parentName: parentAbstract.name
                        });

                        if (childAbstract.childObjects && childAbstract.childObjects.length > 0) {
                            childAbstract.childObjects.forEach(obj => {
                                searchData.abstracts.push({
                                    name: obj.name,
                                    type: 'object',
                                    package: pkgName || '(default)',
                                    url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(childAbstract.uniqueId)}`,
                                    parentName: childAbstract.name
                                });
                            });
                        }
                        addNestedAbstractsAndObjects(childAbstract);
                    });
                }
            }
            addNestedAbstractsAndObjects(abstract);
        });
    });
    return searchData;
}

function generateSearchBarHTML() {
    return `
    <div class="search-global-container">
        <div class="search-wrapper">
            <input type="text" id="global-search" class="global-search-box" placeholder="Search abstracts and packages...">
            <button id="search-button" class="search-button" aria-label="Search">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                </svg>
            </button>
        </div>
        <div id="search-results" class="search-results"></div>
    </div>`;
}

function generateSearchJS(searchData) {
    return `
const searchData = ${JSON.stringify(searchData, null, 2)};

window.expandAndScrollToTarget = function(targetId, scroll = true, updateHash = false, isObjectTarget = false) {
    const targetElement = document.getElementById(targetId);
    if (targetElement) {
        let elementsToExpand = [];
        let el = targetElement.parentElement;
        while (el && el.tagName !== 'BODY') {
            if (el.classList.contains('collapsible-content') && 
                (el.style.display === 'none' || !el.style.display)) {
                const header = el.previousElementSibling;
                if (header) {
                    const button = header.querySelector('button.collapsible');
                    if (button && (button.classList.contains('collapsed') || button.getAttribute('aria-expanded') === 'false')) {
                        elementsToExpand.push({content: el, button: button});
                    }
                }
            }
            el = el.parentElement;
        }

        elementsToExpand.reverse().forEach(item => {
            item.button.classList.remove('collapsed');
            item.button.setAttribute('aria-expanded', 'true');
            const icon = item.button.querySelector('.icon');
            if (icon) icon.textContent = '▼';
            item.content.style.display = 'block';
        });

        if (scroll) {
            setTimeout(() => {
                targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                if (updateHash) {
                    if(history.pushState) {
                        history.pushState(null, null, '#' + encodeURIComponent(targetId));
                    } else {
                        window.location.hash = '#' + encodeURIComponent(targetId);
                    }
                }
            }, 150);
        }

        if (isObjectTarget) {
            const objectsSection = targetElement.querySelector('.objects-section');
            if (objectsSection) {
                const button = objectsSection.querySelector('h3 > button.collapsible');
                const content = objectsSection.querySelector('.collapsible-content');
                if (button && content && (button.classList.contains('collapsed') || button.getAttribute('aria-expanded') === 'false')) {
                    button.classList.remove('collapsed');
                    button.setAttribute('aria-expanded', 'true');
                    const icon = button.querySelector('.icon');
                    if (icon) icon.textContent = '▼';
                    content.style.display = 'block';
                }
            }
        }
    }
};

document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.getElementById('global-search');
    const searchResultsContainer = document.getElementById('search-results');
    const searchButton = document.getElementById('search-button');
    
    if (!searchInput || !searchResultsContainer) return;

    searchInput.addEventListener('input', function() {
        const query = this.value.trim().toLowerCase();
        if (query.length < 2) {
            searchResultsContainer.style.display = 'none';
            return;
        }
        const matchingAbstractsAndObjects = searchData.abstracts
            .filter(item => item.name.toLowerCase().includes(query))
            .slice(0, 10);
        const matchingPackages = searchData.packages
            .filter(item => item.name.toLowerCase().includes(query))
            .slice(0, 3);
        let resultsHTML = '';
        if (matchingAbstractsAndObjects.length > 0) {
            resultsHTML += '<div class="search-category"><h4>Abstracts & Objects</h4><ul>';
            matchingAbstractsAndObjects.forEach(item => {
                let pathDisplay = item.package;
                if (item.parentName) {
                    pathDisplay += ' › ' + item.parentName;
                }
                resultsHTML += \`<li>
                    <a href="\${item.url}" class="search-result-link" data-item-type="\${item.type}">
                        <span class="result-name">\${item.name} <span class="result-item-type">(\${item.type})</span></span>
                        <span class="result-path">\${pathDisplay}</span>
                    </a>
                </li>\`;
            });
            resultsHTML += '</ul></div>';
        }
        if (matchingPackages.length > 0) {
            resultsHTML += '<div class="search-category"><h4>Packages</h4><ul>';
            matchingPackages.forEach(item => {
                resultsHTML += \`<li>
                    <a href="\${item.url}" class="search-result-link">
                        <span class="result-name">\${item.name}</span>
                        <span class="result-path">package</span>
                    </a>
                </li>\`;
            });
            resultsHTML += '</ul></div>';
        }
        if (matchingAbstractsAndObjects.length === 0 && matchingPackages.length === 0) {
            resultsHTML = '<div class="no-results">No matches found</div>';
            resultsHTML += \`<div class="full-text-search">
                <a href="search.html?q=\${encodeURIComponent(query)}">
                    Search in comments and descriptions
                </a>
            </div>\`;
        }
        searchResultsContainer.innerHTML = resultsHTML;
        searchResultsContainer.style.display = 'block';

        const searchResultLinks = searchResultsContainer.querySelectorAll('.search-result-link');
        searchResultLinks.forEach(link => {
            link.addEventListener('click', function(e) {
                const href = this.getAttribute('href');
                const itemType = this.dataset.itemType;
                const [pathAndMaybeQuery, hashFragment] = href.split('#');
                const linkBasePath = pathAndMaybeQuery.split('?')[0];
                const currentBasePath = window.location.pathname.substring(window.location.pathname.lastIndexOf("/") + 1);

                if (hashFragment) {
                    const decodedHash = decodeURIComponent(hashFragment);
                    const isObject = itemType === 'object';
                    if (currentBasePath !== linkBasePath && linkBasePath !== '' && linkBasePath.includes('package_')) {
                        sessionStorage.setItem('expandTarget', decodedHash);
                        if (isObject) {
                            sessionStorage.setItem('expandTargetType', 'object');
                        } else {
                            sessionStorage.removeItem('expandTargetType');
                        }
                    } else if (currentBasePath === linkBasePath || linkBasePath === '') {
                        e.preventDefault();
                        if (typeof window.expandAndScrollToTarget === 'function') {
                            window.expandAndScrollToTarget(decodedHash, true, true, isObject);
                        }
                    }
                }
            });
        });
    });
    document.addEventListener('click', function(event) {
        if (!searchInput.contains(event.target) && 
            !searchResultsContainer.contains(event.target) &&
            !searchButton.contains(event.target)) {
            searchResultsContainer.style.display = 'none';
        }
    });
    searchButton.addEventListener('click', function() {
        const query = searchInput.value.trim();
        if (query.length > 0) {
            window.location.href = \`search.html?q=\${encodeURIComponent(query)}\`;
        }
    });
    searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            const query = this.value.trim();
            if (query.length > 0) {
                window.location.href = \`search.html?q=\${encodeURIComponent(query)}\`;
            }
        }
    });
    
    if (document.body.classList.contains('package-page') || document.title.startsWith('Package:')) {
        return; 
    }

    if (typeof window.expandAndScrollToTarget === 'function') {
        const sessionTarget = sessionStorage.getItem('expandTarget');
        if (sessionTarget) {
            const isObject = sessionStorage.getItem('expandTargetType') === 'object';
            window.expandAndScrollToTarget(sessionTarget, true, false, isObject);
            sessionStorage.removeItem('expandTarget');
            if (isObject) sessionStorage.removeItem('expandTargetType');
        } else if (window.location.hash && window.location.hash.length > 1) {
           window.expandAndScrollToTarget(decodeURIComponent(window.location.hash.substring(1)), true, false, false);
        }
    }
});
`;
}

function generateSearchPage(allPackages) {
    const searchableData = [];
    const cleanStr = str => str ? String(str)
        .replace(/\\n|\n/g, ' ')
        .replace(/```([\s\S]*?)```/g, '$1')
        .replace(/`([^`]+?)`/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^\)]*\)/g, '$1')
        .replace(/^#{1,6}\s+|^>\s*|^\s*[-*+]\s+|^\s*\d+\.\s+|(---|___|\*\*\*)\s*$/gm, '')
        .replace(/(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|~~(.*?)~~/g, '$2$4$5')
        .replace(/\s+/g, ' ')
        .trim() : '';
    
    Object.keys(allPackages).forEach(pkgName => {
        if (pkgName) {
            searchableData.push({
                type: 'package',
                name: pkgName,
                url: `package_${sanitizeFileName(pkgName)}.html`,
                content: `Package ${pkgName}`
            });
        }
    });
    
    Object.keys(allPackages).forEach(pkgName => {
        allPackages[pkgName].abstracts.forEach(abstract => {
            searchableData.push({
                type: 'abstract',
                name: abstract.name,
                package: pkgName || '(default)',
                url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(abstract.uniqueId)}`,
                content: cleanStr(abstract.comments || '')
            });
            if (abstract.childObjects && abstract.childObjects.length > 0) {
                abstract.childObjects.forEach(obj => {
                    searchableData.push({
                        type: 'object',
                        name: obj.name,
                        package: pkgName || '(default)',
                        parent: abstract.name,
                        url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(abstract.uniqueId)}`,
                        content: cleanStr(obj.comments || '')
                    });
                });
            }
            function processNestedAbstracts(parentAbstract) {
                if (parentAbstract.childrenAbstracts && parentAbstract.childrenAbstracts.length > 0) {
                    parentAbstract.childrenAbstracts.forEach(childAbstract => {
                        searchableData.push({
                            type: 'abstract',
                            name: childAbstract.name,
                            package: pkgName || '(default)',
                            parent: parentAbstract.name,
                            url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(childAbstract.uniqueId)}`,
                            content: cleanStr(childAbstract.comments || '')
                        });
                        if (childAbstract.childObjects && childAbstract.childObjects.length > 0) {
                            childAbstract.childObjects.forEach(obj => {
                                searchableData.push({
                                    type: 'object',
                                    name: obj.name,
                                    package: pkgName || '(default)',
                                    parent: childAbstract.name,
                                    parentPath: parentAbstract.name + ' › ' + childAbstract.name,
                                    url: `package_${sanitizeFileName(pkgName)}.html#${encodeURIComponent(childAbstract.uniqueId)}`,
                                    content: cleanStr(obj.comments || '')
                                });
                            });
                        }
                        processNestedAbstracts(childAbstract);
                    });
                }
            }
            processNestedAbstracts(abstract);
        });
    });
    return `<!DOCTYPE html>
<html>
<head>
    <title>Search Results</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="sidebar" id="doc-sidebar">
        <div class="sidebar-header">
            <h2>Navigation</h2>
        </div>
        <div class="sidebar-section">
            <h3 class="sidebar-title">Navigation</h3>
            <ul class="sidebar-list">
                <li class="sidebar-item"><a href="packages.html" class="sidebar-link">All Packages</a></li>
            </ul>
        </div>
    </div>

    <div class="content-wrapper">
        <header>
            <div class="header-content">
                <h1>Search Results</h1>
                ${generateSearchBarHTML()}
            </div>
        </header>
        
        <div id="search-container" class="search-page-container">
            <div class="search-info">
                <p>Enter a search term to find items in documentation.</p>
            </div>
            <div id="search-results-list" class="search-results-list"></div>
        </div>
        
        <footer>
            <p>Generated on ${new Date().toLocaleString()}</p>
        </footer>
    </div>
    
    <script>
        const searchableData = ${JSON.stringify(searchableData)};
        document.addEventListener('DOMContentLoaded', function() {
            const params = new URLSearchParams(window.location.search);
            const query = params.get('q');
            const searchInput = document.getElementById('global-search');
            const resultsContainer = document.getElementById('search-results-list');
            const searchInfo = document.querySelector('.search-info');
            if (searchInput && query) {
                searchInput.value = query;
                performSearch(query);
            }
            function performSearch(query) {
                if (!query || query.trim().length < 2) {
                    searchInfo.innerHTML = '<p>Please enter at least 2 characters to search.</p>';
                    return;
                }
                const normalizedQuery = query.trim().toLowerCase();
                const results = searchableData.filter(item => {
                    return item.name.toLowerCase().includes(normalizedQuery) || 
                           (item.content && item.content.toLowerCase().includes(normalizedQuery));
                });
                if (results.length === 0) {
                    searchInfo.innerHTML = '<p>No results found for "' + escapeHtml(query) + '"</p>';
                    resultsContainer.innerHTML = '';
                    return;
                }
                searchInfo.innerHTML = '<p>Found ' + results.length + ' results for "' + escapeHtml(query) + '"</p>';
                let resultsHTML = '';
                results.forEach(result => {
                    let contentPreview = '';
                    if (result.content) {
                        const content = result.content;
                        const index = content.toLowerCase().indexOf(normalizedQuery);
                        if (index !== -1) {
                            const startPos = Math.max(0, index - 50);
                            const endPos = Math.min(content.length, index + normalizedQuery.length + 50);
                            let preview = content.substring(startPos, endPos);
                            if (startPos > 0) {
                                preview = '...' + preview;
                            }
                            if (endPos < content.length) {
                                preview = preview + '...';
                            }
                            const regex = new RegExp('(' + escapeRegExp(normalizedQuery) + ')', 'gi');
                            contentPreview = escapeHtml(preview).replace(regex, '<mark>$1</mark>');
                        } else {
                            contentPreview = escapeHtml(content.substring(0, 100)) + (content.length > 100 ? '...' : '');
                        }
                    }
                    
                    let resultPath = '';
                    if (result.type === 'package') {
                        resultPath = 'Root Package';
                        if (result.name.includes('.')) {
                            const parts = result.name.split('.');
                            resultPath = 'Child of ' + parts.slice(0, parts.length-1).join('.');
                        }
                    } else {
                        resultPath = result.package || '';
                        resultPath += result.parentPath ? ' › ' + result.parentPath : (result.parent ? ' › ' + result.parent : '');
                    }
                    
                    resultsHTML += \`<div class="search-result-item">
                        <h3>
                            <a href="\${result.url}" class="search-result-link" data-item-type="\${result.type}">\${highlightMatch(escapeHtml(result.name), normalizedQuery)}</a>
                            <span class="result-type \${result.type}-type">\${result.type}</span>
                        </h3>
                        <div class="result-path">
                            \${resultPath}
                        </div>
                        \${contentPreview ? \`<div class="result-preview">\${contentPreview}</div>\` : ''}
                    </div>\`;
                });
                resultsContainer.innerHTML = resultsHTML;
                
                const searchResultLinks = resultsContainer.querySelectorAll('.search-result-link');
                searchResultLinks.forEach(link => {
                    link.addEventListener('click', function(e) {
                        const href = this.getAttribute('href');
                        const itemType = this.dataset.itemType;
                        if (itemType !== 'package') {
                            const [pathAndQuery, hashFragment] = href.split('#');
                            if (hashFragment) {
                                sessionStorage.setItem('expandTarget', decodeURIComponent(hashFragment));
                                if (itemType === 'object') {
                                    sessionStorage.setItem('expandTargetType', 'object');
                                } else {
                                    sessionStorage.removeItem('expandTargetType');
                                }
                            }
                        }
                    });
                });
            }
            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            function escapeRegExp(string) {
                return string.replace(/[.*+?^$\\{}()|[\\]\\\\]/g, '\\\\$&');
            }
            function highlightMatch(text, query) {
                const regex = new RegExp('(' + escapeRegExp(query) + ')', 'gi');
                return text.replace(regex, '<mark>$1</mark>');
            }
        });
    </script>
    <script src="search.js"></script>
</body>
</html>`;
}

async function generateCSS() {
    const cssContent = `
body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    margin: 0;
    padding: 0;
    background-color: #f4f4f4;
    color: #333;
    line-height: 1.6;
}

.sidebar {
    position: fixed;
    width: 300px;
    height: 100%;
    top: 0;
    background-color: #ffffff;
    box-shadow: 2px 0 10px rgba(0, 0, 0, 0.1);
    overflow-y: auto;
    z-index: 1000;
    left: 0;
}

.sidebar-header {
    background-color: #2980b9;
    color: white;
    padding: 15px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.sidebar-header h2 {
    margin: 0;
    color: white;
    font-size: 1.3em;
    border: none;
}

.sidebar-section {
    padding: 15px 0;
    border-bottom: 1px solid #eee;
}

.sidebar-title {
    padding: 0 20px;
    margin: 0 0 10px;
    font-size: 1.1em;
    color: #2c3e50;
}

.sidebar-list {
    list-style-type: none;
    margin: 0;
    padding: 0 10px;
}

.sidebar-item {
    margin-bottom: 2px;
}

.sidebar-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.sidebar-link {
    display: block;
    padding: 5px 10px;
    color: #333;
    text-decoration: none;
    border-radius: 3px;
    flex-grow: 1;
}

.sidebar-link:hover {
    background-color: #f1f1f1;
    color: #2980b9;
    text-decoration: none;
}

.sidebar-link.active {
    background-color: #e1f0fa;
    color: #2980b9;
    font-weight: bold;
}

.sidebar-toggle {
    background: none;
    border: none;
    color: #777;
    cursor: pointer;
    font-size: 12px;
    padding: 5px;
    display: flex;
    align-items: center;
}

.toggle-icon {
    display: inline-block;
    transition: transform 0.2s;
}

.sidebar-nested-list {
    list-style-type: none;
    margin: 0;
    padding-left: 20px;
}

.content-wrapper {
    margin-left: 300px;
    padding: 20px;
}

@media (max-width: 992px) {
    .sidebar {
        width: 250px;
    }
    .content-wrapper {
        margin-left: 250px;
    }
}

@media (max-width: 768px) {
    .sidebar {
        width: 200px;
    }
    .content-wrapper {
        margin-left: 200px;
        padding: 15px;
    }
}

header {
    background-color: #2980b9;
    color: white;
    padding: 20px;
    border-radius: 5px;
    margin-bottom: 20px;
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
    position: relative;
}

.header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
}

h1 {
    color: #f1f1f1;
    margin: 0;
    flex: 1;
    padding-right: 20px;
}

h2 {
    color: #2980b9;
    border-bottom: 1px solid #ddd;
    padding-bottom: 8px;
    margin-top: 20px;
}
h3 {
    color: #2c3e50;
    margin-top: 15px;
    margin-bottom: 15px;
}
a {
    color: #2980b9;
    text-decoration: none;
    transition: color 0.2s;
}
a:hover {
    color: #3498db;
    text-decoration: underline;
}
.comments, .table-description {
    background-color: #fff;
    padding: 15px;
    border-radius: 5px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    margin-bottom: 0;
}
.no-comments, .no-desc {
    background-color: #f9f9f9;
    padding: 15px;
    border-radius: 5px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    margin-bottom: 0;
    color: #666;
    font-style: italic;
}
.comments h1, .comments h2, .comments h3, .comments h4, .comments h5, .comments h6,
.table-description h1, .table-description h2, .table-description h3, .table-description h4, .table-description h5, .table-description h6 {
    color: #2c3e50;
    font-size: 1em;
    margin-top: 10px;
    margin-bottom: 10px;
}
.comments code, .table-description code {
    background-color: #f8f9fa;
    padding: 2px 4px;
    border-radius: 3px;
    font-family: Consolas, Monaco, 'Andale Mono', monospace;
    color: #e74c3c;
}
.comments pre, .table-description pre {
    background-color: #f8f9fa;
    padding: 10px;
    border-radius: 5px;
    overflow-x: auto;
    border-left: 4px solid #2980b9;
    margin: 10px 0;
}
.comments pre code, .table-description pre code {
    background-color: transparent;
    padding: 0;
    color: #333;
}
table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    margin-bottom: 20px;
    background-color: #fff;
    border-radius: 5px;
    overflow: visible;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
thead {
    background-color: #2980b9;
    color: white;
}
th, td {
    padding: 12px 15px;
    text-align: left;
    border-bottom: 1px solid #ddd;
}
tbody tr:hover {
    background-color: #f5f9fa;
}
td:first-child {
    font-weight: bold;
    white-space: nowrap;
    width: 20%;
    vertical-align: top;
}
td.description-cell {
    padding: 15px;
}
td.description-cell > *:first-child {
    margin-top: 0;
}
td.description-cell > *:last-child {
    margin-bottom: 0;
}
.description-section {
    margin-bottom: 20px;
}
section {
    margin-bottom: 30px;
}
footer {
    margin-top: 30px;
    padding-top: 10px;
    border-top: 1px solid #ddd;
    color: #666;
    font-size: 0.9em;
    text-align: center;
}
.abstract-section {
    background: #fff;
    padding: 20px;
    margin-bottom: 25px;
    border-radius: 5px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
.nested-abstract {
    margin-left: 20px;
    border-left: 3px solid #2980b9;
    padding-left: 15px;
    margin-bottom: 15px;
    animation: fadeIn 0.3s ease-in-out;
}
nav {
    background-color: #fff;
    padding: 15px;
    margin-bottom: 20px;
    border-radius: 5px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
nav p, nav h2, nav ul {
    margin-bottom: 10px;
}
nav h2 {
    font-size: 1.2em;
    border-bottom: none;
    padding-bottom: 0;
    margin-top: 10px;
}
.package-list li {
    padding: 8px 0;
    border-bottom: 1px solid #eee;
}
.package-list li:last-child {
    border-bottom: none;
}
.object-count {
    color: #7f8c8d;
    font-size: 0.9em;
    margin-left: 5px;
}

.collapsible {
    background-color: transparent;
    color: #2980b9;
    cursor: pointer;
    padding: 0;
    width: 100%;
    border: none;
    text-align: left;
    outline: none;
    font-size: 1.17em;
    font-weight: bold;
    margin: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: inherit;
}
.collapsible:hover {
    color: #3498db;
}
.collapsible .icon {
    font-size: 0.8em;
    transition: transform 0.3s;
    margin-left: 10px;
}
.collapsible.collapsed .icon {
    transform: rotate(-90deg);
}
.collapsible-content {
    max-height: none;
    overflow: visible;
    transition: max-height 0.3s ease-out;
}

@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}

@media (max-width: 768px) {
    body {
        padding: 10px;
    }
    th, td {
        padding: 8px 10px;
    }
    td:first-child {
        width: auto;
    }
    .nested-abstract {
        margin-left: 10px;
        padding-left: 10px;
    }
}

.search-container {
    margin-bottom: 15px;
    position: relative;
}
.search-box {
    width: 100%;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 5px;
    font-size: 14px;
    box-sizing: border-box;
}
.search-box:focus {
    outline: none;
    border-color: #2980b9;
    box-shadow: 0 0 5px rgba(41, 128, 185, 0.5);
}
.nested-abstracts {
    margin-top: 10px;
}
.no-desc {
    color: #999;
    font-style: italic;
    padding: 10px 0;
    display: inline-block;
}

tbody tr:last-child td {
    border-bottom: none;
    padding-bottom: 15px;
}

td.table-description pre {
    max-width: 100%;
    word-wrap: break-word;
    white-space: pre-wrap;
}

td.table-description {
    padding: 15px;
    min-height: 30px;
    height: auto !important;
    overflow: visible;
}

.table-description p:last-child {
    margin-bottom: 0;
}

.nested-abstracts-section {
    margin-top: 20px;
}
.nested-abstract {
    margin-left: 20px;
    border-left: 3px solid #2980b9;
    padding-left: 15px;
    margin-bottom: 30px;
    animation: fadeIn 0.4s ease-in-out;
}
.nested-abstract .abstract-section {
    margin-bottom: 15px;
}
.nested-abstract h2 {
    font-size: 1.5em;
    margin-top: 10px;
    margin-bottom: 15px;
}
.nested-abstract .nested-abstract {
    margin-left: 15px;
    border-left: 3px solid #3498db;
}
.nested-abstract .nested-abstract .nested-abstract {
    border-left: 3px solid #9b59b6;
}

.nested-abstracts {
    overflow: visible;
}

.search-global-container {
    position: relative;
    width: 300px;
    flex-shrink: 0;
}

.search-wrapper {
    display: flex;
    width: 100%;
    position: relative;
}

.global-search-box {
    width: 100%;
    padding: 10px 35px 10px 15px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 20px;
    font-size: 14px;
    box-sizing: border-box;
    background-color: rgba(255, 255, 255, 0.15);
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
    transition: all 0.3s;
    color: white;
}

.global-search-box::placeholder {
    color: rgba(255, 255, 255, 0.7);
}

.global-search-box:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.8);
    background-color: rgba(255, 255, 255, 0.25);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);
}

.search-button {
    background-color: transparent;
    border: none;
    color: white;
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    cursor: pointer;
    padding: 0;
}

.search-button:hover {
    color: #eaeaea;
}

.search-results {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background-color: white;
    border-radius: 5px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    margin-top: 5px;
    max-height: 400px;
    overflow-y: auto;
    display: none;
    z-index: 1010;
}

.search-results ul {
    list-style: none;
    padding: 0;
    margin: 0;
}

.search-results li {
    padding: 0;
    margin: 0;
    border-bottom: 1px solid #eee;
}

.search-results li:last-child {
    border-bottom: none;
}

.search-results a {
    display: block;
    padding: 10px 15px;
    color: #333;
    text-decoration: none;
    transition: background-color 0.2s;
}

.search-results a:hover {
    background-color: #f5f9fa;
    text-decoration: none;
}

.search-category {
    padding: 0;
}

.search-category h4 {
    margin: 0;
    padding: 8px 15px;
    background-color: #f1f1f1;
    font-size: 14px;
    font-weight: 600;
    color: #666;
}

.result-name {
    display: block;
    font-weight: 500;
    margin-bottom: 2px;
}

.result-path {
    display: block;
    font-size: 12px;
    color: #777;
}

.result-item-type {
    font-size: 0.8em;
    color: #777;
    margin-left: 5px;
    font-style: italic;
}

.no-results {
    padding: 15px;
    color: #666;
    text-align: center;
    font-style: italic;
}

.full-text-search {
    padding: 10px 15px;
    text-align: center;
    border-top: 1px solid #eee;
}

.full-text-search a {
    color: #2980b9;
    text-decoration: none;
    font-size: 13px;
}

.full-text-search a:hover {
    text-decoration: underline;
}

.search-page-container {
    background-color: white;
    padding: 20px;
    border-radius: 5px;
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
}

.search-info {
    margin-bottom: 20px;
    color: #666;
}

.search-results-list {
    margin-top: 20px;
}

.search-result-item {
    margin-bottom: 25px;
    padding-bottom: 20px;
    border-bottom: 1px solid #eee;
}

.search-result-item:last-child {
    border-bottom: none;
}

.search-result-item h3 {
    margin: 0 0 5px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.search-result-item h3 a {
    color: #2980b9;
    text-decoration: none;
}

.search-result-item h3 a:hover {
    text-decoration: underline;
}

.result-type {
    font-size: 12px;
    color: white;
    background-color: #95a5a6;
    padding: 3px 8px;
    border-radius: 12px;
    font-weight: normal;
    margin-left: 10px;
}

.result-preview {
    margin-top: 10px;
    color: #555;
    line-height: 1.5;
}

mark {
    background-color: #fff3cd;
    padding: 1px 2px;
    border-radius: 2px;
}

@media (max-width: 768px) {
    .header-content {
        flex-direction: column;
        align-items: flex-start;
    }
    
    h1 {
        margin-bottom: 15px;
        padding-right: 0;
    }
    
    .search-global-container {
        width: 100%;
    }
    
    header {
        padding: 15px;
    }
}

.package-type {
    background-color: #3498db;
}

.abstract-type {
    background-color: #2ecc71;
}

.object-type {
    background-color: #e67e22;
}
    `;
    await fs.promises.writeFile(path.join(outputDir, 'styles.css'), cssContent, 'utf-8');
}

function getPackageNameFromFilePath(filePath) {
    const relativePath = path.relative(inputDir, filePath);
    const dirName = path.dirname(relativePath);
    if (dirName === '.' || dirName === '') {
        return '';
    }
    return dirName.split(path.sep).join('.');
}

async function generateDocumentation(opts) {
    const skipUncommented = opts.skipUncommented || false;
    console.log(`Using input directory: ${inputDir}`);
    console.log(`Output will be generated in: ${outputDir}`);
    try {
        try {
            await fs.promises.access(inputDir, fs.constants.R_OK);
        } catch (err) {
            console.error(`Error: Input directory "${inputDir}" does not exist or is not readable.`);
            process.exit(1);
        }
        await fs.promises.mkdir(outputDir, { recursive: true });
        await generateCSS();
        const allFiles = await readxmirFilesRecursively(inputDir);
        if (allFiles.length === 0) {
            console.warn(`Warning: No .xmir files found in "${inputDir}". Please check your input directory.`);
        } else {
            console.log(`Found ${allFiles.length} .xmir files to process.`);
        }
        for (const filePath of allFiles) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const parsed = await parseXML(content);
            const programXML = parsed.program;
            const commentsXml = programXML.comments && programXML.comments[0] && programXML.comments[0].comment;
            const comments = extractComments(commentsXml);
            const lineToCommentMap = buildLineToCommentMap(comments);
            const objects = programXML.objects && programXML.objects[0] && programXML.objects[0].o;
            const abstracts = [];
            buildAbstracts(objects, lineToCommentMap, null, abstracts, skipUncommented);
            const pkgName = getPackageNameFromFilePath(filePath);
            if (!packages[pkgName]) {
                packages[pkgName] = {
                    name: pkgName,
                    abstracts: []
                };
            }
            packages[pkgName].abstracts.push(...abstracts);
        }
        const allPackageNames = Object.keys(packages);
        allPackageNames.forEach(fullPkgName => {
            if (fullPkgName.includes('.')) {
                const parts = fullPkgName.split('.');
                for (let i = 1; i < parts.length; i++) {
                    const parentPkgName = parts.slice(0, i).join('.');
                    if (!packages[parentPkgName]) {
                        packages[parentPkgName] = {
                            name: parentPkgName,
                            abstracts: []
                        };
                    }
                }
            }
        });
        const searchData = collectSearchableItems(packages);
        await fs.promises.writeFile(path.join(outputDir, 'search.js'), generateSearchJS(searchData), 'utf-8');
        const searchPageHtml = generateSearchPage(packages);
        await fs.promises.writeFile(path.join(outputDir, 'search.html'), searchPageHtml, 'utf-8');
        const packagesHtml = generatePackagesPage(packages);
        await fs.promises.writeFile(path.join(outputDir, 'packages.html'), packagesHtml, 'utf-8');
        for (const pkgName of Object.keys(packages)) {
            const html = generatePackagePage(pkgName, packages[pkgName], packages);
            await fs.promises.writeFile(path.join(outputDir, `package_${sanitizeFileName(pkgName)}.html`), html, 'utf-8');
        }
        console.log('Documentation successfully generated in the "docs" folder.');
    } catch (error) {
        console.error('Error generating documentation:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    generateDocumentation(options);
}

module.exports = generateDocumentation;
