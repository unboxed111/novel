/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from '@google/genai';

// --- Type Definitions ---
interface Bookmark {
    id: string;
    text: string;
    chapterIndex: number;
    paragraphIndex: number;
}

interface Chapter {
  title: string;
  paragraphs: string[];
}

interface Book {
  id: number;
  title: string;
  author: string;
  fileBlob: Blob; // The raw file content
  encoding: string; // 'utf-8', 'gbk'
  lastReadChapterIndex?: number;
  lastReadParagraphIndex?: number;
  bookmarks?: Bookmark[];
  isTemporary?: boolean;
}

interface ContextMenu {
  x: number;
  y: number;
  bookId: number;
}

interface TypographySettings {
    fontSize: number;
    lineHeight: number;
    fontFamily: 'sans-serif' | 'serif';
}

interface SelectionPopup {
    range: Range;
    top: number;
    left: number;
}

// --- Database Helper ---
const DB_NAME = 'AIReaderDB';
const STORE_NAME = 'books';

const promisifyTransaction = (transaction: IDBTransaction): Promise<void> => {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted.', 'AbortError'));
    });
};

const db = {
  async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => reject("Error opening DB");
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  },
  async getBooks(): Promise<Book[]> {
    const db = await this.openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
    });
  },
  async addBook(book: Book) {
    const db = await this.openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.add(book);
    return promisifyTransaction(transaction);
  },
  async deleteBook(id: number) {
    const db = await this.openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.delete(id);
    return promisifyTransaction(transaction);
  },
  async updateBook(book: Book) {
      const db = await this.openDB();
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(book);
      return promisifyTransaction(transaction);
  },
};


// --- Helper Functions ---
const parseTextToChapters = (content: string): Chapter[] => {
    const chapters: Chapter[] = [];
    const chapterRegex = /^(第\s*[一二三四五六七八九十百千零〇\d]+\s*[章节回])|^(序章|引子|楔子|前言|后记|番外)/gm;

    const lines = content.split(/\r?\n/);
    let currentChapterContent: string[] = [];
    let currentChapterTitle = '前言';

    for (const line of lines) {
        if (chapterRegex.test(line.trim())) {
            if (currentChapterContent.join('').trim()) {
                chapters.push({
                    title: currentChapterTitle,
                    paragraphs: currentChapterContent.filter(p => p.trim() !== ''),
                });
            }
            currentChapterTitle = line.trim();
            currentChapterContent = [];
            chapterRegex.lastIndex = 0;
        } else {
            currentChapterContent.push(line.trim());
        }
    }

    if (currentChapterContent.join('').trim()) {
        chapters.push({
            title: currentChapterTitle,
            paragraphs: currentChapterContent.filter(p => p.trim() !== ''),
        });
    }

    if (chapters.length === 0 && content.trim()) {
        chapters.push({
            title: '全文',
            paragraphs: content.split(/\r?\n/).filter(p => p.trim() !== ''),
        });
    }

    return chapters;
};


// --- Components ---

const ContextMenuComponent = ({ menu, onSelectDelete }) => {
    if (!menu) return null;

    return (
        <div className="context-menu" style={{ top: menu.y, left: menu.x }}>
            <div className="context-menu-item" onClick={() => onSelectDelete(menu.bookId)}>
                删除书籍
            </div>
        </div>
    );
};

const BookshelfView = ({ books, onSelectBook, onImportBook, onShowContextMenu }) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleImportBookClick = () => {
        fileInputRef.current?.click();
    };
    
    const handleBookFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            onImportBook(file);
            event.target.value = '';
        }
    };
    
    return (
        <div className="bookshelf-view" aria-label="书架视图">
            <header className="bookshelf-header">
                 <h1>我的书架</h1>
                 <p>导入或选择一本书开始阅读</p>
            </header>
            <main>
                <div className="bookshelf-grid">
                    {books.map(book => (
                        <article 
                            key={book.id} 
                            className="book-card" 
                            onClick={() => onSelectBook(book)} 
                            onContextMenu={(e) => onShowContextMenu(e, book.id)}
                            onKeyDown={(e) => e.key === 'Enter' && onSelectBook(book)} 
                            role="button" 
                            tabIndex={0} 
                            aria-label={`阅读 ${book.title}`}
                        >
                            <div className="book-title">{book.title}</div>
                            <div className="book-author">{book.author}</div>
                        </article>
                    ))}
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleBookFileChange}
                        accept=".txt"
                        style={{ display: 'none' }}
                        aria-hidden="true"
                    />
                    <button className="import-button" aria-label="导入新书籍" onClick={handleImportBookClick}>
                        <div className="import-icon">+</div>
                        <div>导入书籍</div>
                    </button>
                </div>
            </main>
        </div>
    );
};

const DisplaySettingsComponent = ({ theme, onThemeChange, typography, onTypographyChange, isOpen, setIsOpen, encoding, onEncodingChange }) => {
    const menuRef = useRef(null);

    const themes = [
        { key: 'theme-dark', name: '深邃黑' },
        { key: 'theme-light', name: '简约白' },
        { key: 'theme-sepia', name: '护眼米' },
    ];

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [menuRef, setIsOpen]);

    return (
        <div className="display-settings" ref={menuRef}>
            <button className="control-button" onClick={() => setIsOpen(!isOpen)} aria-label="显示设置 (S)">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            {isOpen && (
                <div className="display-settings-dropdown">
                    <div className="settings-group">
                        <div className="settings-label">主题</div>
                        <div className="theme-options">
                            {themes.map(t => (
                                <button
                                    key={t.key}
                                    className={`theme-button ${theme === t.key ? 'active' : ''}`}
                                    onClick={() => onThemeChange(t.key)}
                                >
                                    {t.name}
                                </button>
                            ))}
                        </div>
                    </div>
                     <div className="settings-group">
                        <div className="settings-label">文件编码</div>
                         <select className="encoding-select" value={encoding} onChange={(e) => onEncodingChange(e.target.value)}>
                            <option value="utf-8">UTF-8</option>
                            <option value="gbk">GBK</option>
                        </select>
                    </div>
                    <div className="settings-group">
                        <div className="settings-label">字体</div>
                        <div className="font-options">
                            <button className={`font-button ${typography.fontFamily === 'sans-serif' ? 'active' : ''}`} onClick={() => onTypographyChange({ fontFamily: 'sans-serif' })}>无衬线</button>
                            <button className={`font-button serif ${typography.fontFamily === 'serif' ? 'active' : ''}`} onClick={() => onTypographyChange({ fontFamily: 'serif' })}>衬线体</button>
                        </div>
                    </div>
                     <div className="settings-group">
                        <div className="settings-label">字号</div>
                        <div className="slider-container">
                             <span className="icon small">A</span>
                             <input type="range" min="14" max="28" step="1" value={typography.fontSize} onChange={(e) => onTypographyChange({ fontSize: Number(e.target.value) })} />
                             <span className="icon">A</span>
                        </div>
                    </div>
                     <div className="settings-group">
                        <div className="settings-label">行距</div>
                        <div className="slider-container">
                             <svg stroke="currentColor" fill="currentColor" strokeWidth="0" viewBox="0 0 24 24" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg" className="icon"><path d="M10 4h4v2h-4zM5 18h14v2H5zm-2-7h18v2H3zm5-4h8v2H8z"></path></svg>
                             <input type="range" min="1.4" max="2.4" step="0.1" value={typography.lineHeight} onChange={(e) => onTypographyChange({ lineHeight: Number(e.target.value) })}/>
                             <svg stroke="currentColor" fill="currentColor" strokeWidth="0" viewBox="0 0 24 24" height="1.2em" width="1.2em" xmlns="http://www.w3.org/2000/svg" className="icon"><path d="M10 4h4v2h-4zM3 18h18v2H3zm2-7h14v2H5zm5-4h8v2h-8z"></path></svg>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const CardView = ({ chapters, activeChapterIndex, activeParagraphIndex, setActiveChapterIndex, setActiveParagraphIndex }) => {
    const chapter = chapters[activeChapterIndex];
    if (!chapter) return null;

    const paragraph = chapter.paragraphs[activeParagraphIndex];

    const handlePrev = () => {
        if (activeParagraphIndex > 0) {
            setActiveParagraphIndex(prev => prev - 1);
        } else if (activeChapterIndex > 0) {
            const prevChapterIndex = activeChapterIndex - 1;
            const prevChapter = chapters[prevChapterIndex];
            setActiveChapterIndex(prevChapterIndex);
            setActiveParagraphIndex(prevChapter.paragraphs.length - 1);
        }
    };

    const handleNext = () => {
        if (activeParagraphIndex < chapter.paragraphs.length - 1) {
            setActiveParagraphIndex(prev => prev + 1);
        } else if (activeChapterIndex < chapters.length - 1) {
            const nextChapterIndex = activeChapterIndex + 1;
            setActiveChapterIndex(nextChapterIndex);
            setActiveParagraphIndex(0);
        }
    };
    
    const isFirst = activeChapterIndex === 0 && activeParagraphIndex === 0;
    const isLast = activeChapterIndex === chapters.length - 1 && activeParagraphIndex === chapter.paragraphs.length - 1;

    return (
        <div className="card-view">
            <div className="card-content">
                <header className="card-header">
                    <h4>{chapter.title}</h4>
                    <span>{chapter.paragraphs.length > 0 ? `${activeParagraphIndex + 1} / ${chapter.paragraphs.length}`: '0 / 0'}</span>
                </header>
                <div className="card-body">
                    <p>{paragraph || "本章结束。"}</p>
                </div>
                <footer className="card-footer">
                    <button onClick={handlePrev} disabled={isFirst}>上一段</button>
                    <button onClick={handleNext} disabled={isLast}>下一段</button>
                </footer>
            </div>
        </div>
    );
};

const ReaderLoading = () => (
    <div className="reader-loading">
        <div className="reader-loading-spinner"></div>
        <p>正在解析书籍...</p>
    </div>
);


const ReaderView = ({ book, onBack, onBookUpdate, theme, onThemeChange, typography, onTypographyChange, ai }) => {
    const [chapters, setChapters] = useState<Chapter[] | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeChapterIndex, setActiveChapterIndex] = useState(book.lastReadChapterIndex || 0);
    const [activeParagraphIndex, setActiveParagraphIndex] = useState(book.lastReadParagraphIndex || 0);
    const [activeTab, setActiveTab] = useState('chapters');
    const [selectionPopup, setSelectionPopup] = useState<SelectionPopup | null>(null);
    const [isImmersive, setIsImmersive] = useState(false);
    const [isCardMode, setIsCardMode] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isAiHelperOpen, setIsAiHelperOpen] = useState(false);
    const [chapterSummary, setChapterSummary] = useState<{ isLoading: boolean; content: string | null; error: string | null } | null>(null);
    const [inlineAiResult, setInlineAiResult] = useState<{ top: number; left: number; width: number; isLoading: boolean; content: string | null; error: string | null; title: string; } | null>(null);
    const mainContentRef = useRef<HTMLElement>(null);
    const readerViewRef = useRef<HTMLDivElement>(null);
    const aiHelperRef = useRef(null);

    // Effect to parse book content when the blob or encoding changes
    useEffect(() => {
        let isMounted = true;
        setIsLoading(true);
        const parseBook = async () => {
            try {
                const buffer = await book.fileBlob.arrayBuffer();
                const decoder = new TextDecoder(book.encoding);
                const textContent = decoder.decode(buffer);
                if (isMounted) setChapters(parseTextToChapters(textContent));
            } catch (error) {
                if (isMounted) {
                    console.error("Failed to parse book content with encoding:", book.encoding, error);
                    setChapters([]);
                }
            } finally {
                if (isMounted) setIsLoading(false);
            }
        };
        parseBook();
        return () => { isMounted = false; };
    }, [book.fileBlob, book.encoding]);

    // Effect to sync local reading position FROM parent props when they change
    useEffect(() => {
        setActiveChapterIndex(book.lastReadChapterIndex || 0);
        setActiveParagraphIndex(book.lastReadParagraphIndex || 0);
    }, [book.lastReadChapterIndex, book.lastReadParagraphIndex]);
    
    // Effect to save progress TO parent props when local state changes
    useEffect(() => {
        if (!isLoading && !book.isTemporary && (book.lastReadChapterIndex !== activeChapterIndex || book.lastReadParagraphIndex !== activeParagraphIndex)) {
             onBookUpdate({ ...book, lastReadChapterIndex: activeChapterIndex, lastReadParagraphIndex: activeParagraphIndex });
        }
    }, [activeChapterIndex, activeParagraphIndex, book, onBookUpdate, isLoading]);

    // Close AI helper when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (aiHelperRef.current && !aiHelperRef.current.contains(event.target)) {
                setIsAiHelperOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [aiHelperRef]);


    // UI effects when chapter changes
    useEffect(() => {
        if (!isCardMode) {
            mainContentRef.current?.scrollTo(0, 0);
        }
        setSelectionPopup(null);
        setChapterSummary(null);
        setInlineAiResult(null);
    }, [activeChapterIndex, isCardMode]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsImmersive(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    const selectChapter = useCallback((index: number) => {
        if (index !== activeChapterIndex) {
            setActiveChapterIndex(index);
            setActiveParagraphIndex(0);
        }
    }, [activeChapterIndex]);

    const toggleImmersiveMode = useCallback(() => {
        if (!document.fullscreenElement) {
            readerViewRef.current?.requestFullscreen();
        } else if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }, []);
    
    const handleCardModeToggle = useCallback(() => {
        setIsCardMode(prevIsCardMode => {
            if (prevIsCardMode) { // when exiting card mode
                setTimeout(() => mainContentRef.current?.scrollTo(0, 0), 0);
            }
            return !prevIsCardMode;
        });
    }, []);

    const handleEncodingChange = useCallback((newEncoding: string) => {
        onBookUpdate({ ...book, encoding: newEncoding });
    }, [book, onBookUpdate]);

    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        const target = event.target as HTMLElement;
        if (['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(target.tagName) || (event.target as HTMLElement).closest('.ai-popover')) {
            return;
        }

        const key = event.key.toLowerCase();
        const handledKeys = ['arrowleft', 'arrowright', 'c', 'f', 's'];
        if (!handledKeys.includes(key) || !chapters) {
            return;
        }
        
        event.preventDefault();
        const chapter = chapters[activeChapterIndex];

        switch (key) {
            case 'arrowleft':
                if (isCardMode) {
                    if (activeParagraphIndex > 0) {
                        setActiveParagraphIndex(p => p - 1);
                    } else if (activeChapterIndex > 0) {
                        const prevChapter = chapters[activeChapterIndex - 1];
                        setActiveChapterIndex(c => c - 1);
                        setActiveParagraphIndex(prevChapter.paragraphs.length - 1);
                    }
                } else {
                    if (activeChapterIndex > 0) {
                        selectChapter(activeChapterIndex - 1);
                    }
                }
                break;
            case 'arrowright':
                if (isCardMode) {
                    if (chapter && activeParagraphIndex < chapter.paragraphs.length - 1) {
                        setActiveParagraphIndex(p => p + 1);
                    } else if (activeChapterIndex < chapters.length - 1) {
                        setActiveChapterIndex(c => c + 1);
                        setActiveParagraphIndex(0);
                    }
                } else {
                     if (activeChapterIndex < chapters.length - 1) {
                        selectChapter(activeChapterIndex - 1);
                    }
                }
                break;
            case 'c':
                handleCardModeToggle();
                break;
            case 'f':
                toggleImmersiveMode();
                break;
            case 's':
                setIsSettingsOpen(prev => !prev);
                break;
        }
    }, [ chapters, isCardMode, activeChapterIndex, activeParagraphIndex, selectChapter, handleCardModeToggle, toggleImmersiveMode ]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [handleKeyDown]);

    const handleMouseUp = useCallback((event: React.MouseEvent) => {
        if (isCardMode) return;

        const controlsContainer = readerViewRef.current?.querySelector('.reader-top-controls');
        const popoverContainer = readerViewRef.current?.querySelector('.ai-popover');
        if ((controlsContainer && controlsContainer.contains(event.target as Node)) || (popoverContainer && popoverContainer.contains(event.target as Node))) {
            return;
        }

        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && mainContentRef.current?.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            const containerRect = readerViewRef.current!.getBoundingClientRect();
            setSelectionPopup({
                range,
                top: rect.top - containerRect.top - 50,
                left: rect.left - containerRect.left + rect.width / 2,
            });
            setInlineAiResult(null); // Hide AI result when making a new selection
        } else {
            setSelectionPopup(null);
        }
    }, [isCardMode, readerViewRef, mainContentRef]);

    const getPrompt = (action: string, text: string, context: any = {}) => {
        switch (action) {
            case 'summarize':
                return `You are a helpful reading assistant. Please provide a concise summary in Chinese for the following chapter from the book "${context.bookTitle}". The chapter is titled "${context.chapterTitle}". Chapter content:\n\n"${text}"`;
            case 'explain':
                return `You are a helpful reading assistant. The user has selected the following text from a book. Please explain it in simple, clear Chinese. The text is: "${text}"`;
            case 'translate':
                return `You are a helpful reading assistant. The user has selected the following Chinese text from a book. Please translate it into English, with Chinese explanations underneath the translation. The text is: "${text}"`;
            default:
                return text;
        }
    };

    const handleAiAction = async (action: 'summarize' | 'explain' | 'translate', payload: { text: string; range?: Range; context?: any}) => {
        if (!ai) return;

        setSelectionPopup(null);
        if(payload.range) {
            window.getSelection()?.removeAllRanges();
        }

        try {
            const prompt = getPrompt(action, payload.text, payload.context);
            
            if (action === 'summarize') {
                setChapterSummary({ isLoading: true, content: null, error: null });
            } else if (payload.range) {
                 const rect = payload.range.getBoundingClientRect();
                 const containerRect = readerViewRef.current!.getBoundingClientRect();
                 setInlineAiResult({
                    top: rect.bottom - containerRect.top + 8,
                    left: rect.left - containerRect.left,
                    width: rect.width,
                    isLoading: true,
                    content: null,
                    error: null,
                    title: action === 'explain' ? '文本解释' : '翻译结果'
                 });
            }

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    thinkingConfig: { thinkingBudget: 0 }
                }
            });
            
            if (action === 'summarize') {
                setChapterSummary({ isLoading: false, content: response.text, error: null });
            } else {
                setInlineAiResult(prev => prev ? {...prev, isLoading: false, content: response.text } : null);
            }

        } catch (err) {
            console.error("AI action failed:", err);
            const errorMsg = "AI 处理时发生错误。";
            if (action === 'summarize') {
                setChapterSummary({ isLoading: false, content: null, error: errorMsg });
            } else {
                 setInlineAiResult(prev => prev ? {...prev, isLoading: false, error: errorMsg } : null);
            }
        }
    }

    const handleAddBookmark = () => {
        if (!selectionPopup) return;
        const { range } = selectionPopup;
        const text = range.toString().trim();
        if (!text) return;

        const startNode = range.startContainer;
        const paragraphEl = (startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode as HTMLElement)?.closest('p[data-p-index]');
        
        if (paragraphEl) {
            const paragraphIndex = parseInt(paragraphEl.getAttribute('data-p-index')!, 10);
            const newBookmark: Bookmark = {
                id: `${Date.now()}`, text, chapterIndex: activeChapterIndex, paragraphIndex,
            };
            const updatedBook: Book = { ...book, bookmarks: [...(book.bookmarks || []), newBookmark] };
            onBookUpdate(updatedBook);
            setSelectionPopup(null);
            window.getSelection()?.removeAllRanges();
        }
    };

    const handleDeleteBookmark = (bookmarkId: string) => {
        const updatedBook: Book = { ...book, bookmarks: book.bookmarks?.filter(b => b.id !== bookmarkId) };
        onBookUpdate(updatedBook);
    };

    const handleGoToBookmark = (bookmark: Bookmark) => {
        setActiveChapterIndex(bookmark.chapterIndex);
        setTimeout(() => {
            document.getElementById(`bookmark-${bookmark.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
    };

    const renderParagraphWithBookmarks = (paragraphText: string, pIndex: number) => {
        const bookmarksInParagraph = (book.bookmarks || [])
            .filter(b => b.chapterIndex === activeChapterIndex && b.paragraphIndex === pIndex)
            .sort((a, b) => paragraphText.indexOf(a.text) - paragraphText.indexOf(b.text));

        if (bookmarksInParagraph.length === 0) {
            return <p key={pIndex} data-p-index={pIndex}>{paragraphText}</p>;
        }

        let lastIndex = 0;
        const parts: (string | JSX.Element)[] = [];
        bookmarksInParagraph.forEach(bookmark => {
            const startIndex = paragraphText.indexOf(bookmark.text, lastIndex);
            if (startIndex === -1) return;
            if (startIndex > lastIndex) parts.push(paragraphText.substring(lastIndex, startIndex));
            parts.push(<mark key={bookmark.id} id={`bookmark-${bookmark.id}`} className="bookmark-highlight">{bookmark.text}</mark>);
            lastIndex = startIndex + bookmark.text.length;
        });
        if (lastIndex < paragraphText.length) parts.push(paragraphText.substring(lastIndex));
        
        return <p key={pIndex} data-p-index={pIndex}>{parts}</p>;
    };

    const readerMainStyle = {
        '--reader-font-size': `${typography.fontSize}px`,
        '--reader-line-height': typography.lineHeight,
        '--reader-font-family': typography.fontFamily === 'serif' ? 'var(--font-family-serif)' : 'var(--font-family-sans-serif)',
    } as React.CSSProperties;

    if (isLoading) {
        return <ReaderLoading />;
    }
    
    if (!chapters || chapters.length === 0) {
        return (
             <div className={`reader-view`} ref={readerViewRef}>
                  <aside className="reader-sidebar" style={{transform: 'translateX(0)'}}>
                      <button onClick={onBack} className="back-to-shelf-btn">&larr; 返回书架</button>
                  </aside>
                  <main className="reader-main">
                      <div className="reader-error">
                          <h2>无法加载书籍</h2>
                          <p>文件内容解析失败。请尝试在右上角的设置菜单中切换文件编码（如 GBK）。</p>
                      </div>
                  </main>
                   <div className="reader-top-controls">
                      <DisplaySettingsComponent
                          theme={theme}
                          onThemeChange={onThemeChange}
                          typography={typography}
                          onTypographyChange={onTypographyChange}
                          isOpen={isSettingsOpen}
                          setIsOpen={setIsSettingsOpen}
                          encoding={book.encoding}
                          onEncodingChange={handleEncodingChange}
                      />
                  </div>
            </div>
        )
    }

    const activeChapter = chapters[activeChapterIndex];

    return (
        <div className={`reader-view ${isImmersive ? 'immersive' : ''} ${isCardMode ? 'card-mode-active' : ''}`} ref={readerViewRef} aria-label="阅读器视图" onMouseUp={handleMouseUp}>
            <aside className="reader-sidebar">
                <button onClick={onBack} className="back-to-shelf-btn">&larr; 返回书架</button>
                <div className="sidebar-tabs">
                    <button className={`tab-button ${activeTab === 'chapters' ? 'active' : ''}`} onClick={() => setActiveTab('chapters')}>目录</button>
                    <button className={`tab-button ${activeTab === 'bookmarks' ? 'active' : ''}`} onClick={() => setActiveTab('bookmarks')}>书签</button>
                </div>
                <div className="sidebar-content">
                    {activeTab === 'chapters' && (
                        <nav className="chapter-list" aria-label="章节导航">
                            <h2>{book.title}</h2>
                            <ul>
                                {chapters.map((chapter, index) => (
                                    <li key={`${book.id}-${index}`} tabIndex={0} role="button" aria-label={`跳转到 ${chapter.title}`}
                                        className={index === activeChapterIndex ? 'active' : ''}
                                        onClick={() => selectChapter(index)}
                                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && selectChapter(index)}>
                                        {chapter.title}
                                    </li>
                                ))}
                            </ul>
                        </nav>
                    )}
                    {activeTab === 'bookmarks' && (
                        <div className="bookmark-list" aria-label="书签列表">
                             <h2>书签</h2>
                             {book.bookmarks && book.bookmarks.length > 0 ? (
                                <ul>
                                    {book.bookmarks.map(bookmark => (
                                        <li key={bookmark.id} className="bookmark-item">
                                            <div className="bookmark-text" onClick={() => handleGoToBookmark(bookmark)} title={bookmark.text}>
                                                {bookmark.text}
                                            </div>
                                            <div className="bookmark-meta">
                                                <span>{chapters[bookmark.chapterIndex]?.title || '未知章节'}</span>
                                                <button
                                                    onClick={() => handleDeleteBookmark(bookmark.id)}
                                                    className="delete-bookmark-btn"
                                                    aria-label={`删除书签: ${bookmark.text}`}
                                                >
                                                    &times;
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div className="empty-list-placeholder">
                                    <p>还没有书签。</p>
                                    <p>在正文中选中文本即可添加。</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </aside>
            <main ref={mainContentRef} className="reader-main" style={readerMainStyle} onScroll={() => setSelectionPopup(null)}>
                {isCardMode ? (
                     <CardView
                        chapters={chapters}
                        activeChapterIndex={activeChapterIndex}
                        activeParagraphIndex={activeParagraphIndex}
                        setActiveChapterIndex={setActiveChapterIndex}
                        setActiveParagraphIndex={setActiveParagraphIndex}
                     />
                ) : (
                    <>
                    {selectionPopup && (
                        <div
                            className="bookmark-popup"
                            style={{ top: selectionPopup.top, left: selectionPopup.left }}
                        >
                            <button onClick={handleAddBookmark}>书签</button>
                            <button onClick={() => handleAiAction('explain', { text: selectionPopup.range.toString(), range: selectionPopup.range })}>解释</button>
                            <button onClick={() => handleAiAction('translate', { text: selectionPopup.range.toString(), range: selectionPopup.range })}>翻译</button>
                        </div>
                    )}
                     {inlineAiResult && (
                        <div className="ai-popover" style={{ top: inlineAiResult.top, left: inlineAiResult.left }}>
                            <div className="ai-popover-header">
                                <h3>{inlineAiResult.title}</h3>
                                <button className="close-btn" onClick={() => setInlineAiResult(null)}>&times;</button>
                            </div>
                            <div className="ai-popover-body">
                                {inlineAiResult.isLoading && <div className="summary-loading">AI 处理中...</div>}
                                {inlineAiResult.error && <div className="summary-error">{inlineAiResult.error}</div>}
                                {inlineAiResult.content && <p>{inlineAiResult.content}</p>}
                            </div>
                        </div>
                    )}
                    <article>
                        <h1>{activeChapter.title}</h1>
                        {chapterSummary && (
                            <div className="chapter-summary">
                                {chapterSummary.isLoading && <div className="summary-loading">AI 总结中...</div>}
                                {chapterSummary.error && <div className="summary-error">{chapterSummary.error}</div>}
                                {chapterSummary.content && <blockquote>{chapterSummary.content}</blockquote>}
                            </div>
                        )}
                        {activeChapter.paragraphs.map((p, i) => renderParagraphWithBookmarks(p, i))}
                    </article>
                    </>
                )}
            </main>
            <div className="reader-top-controls">
                 <button className="control-button immersive-mode-toggle" onClick={toggleImmersiveMode} aria-label="沉浸模式 (F)">
                     <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                 </button>
                 <button className="control-button card-mode-toggle" onClick={handleCardModeToggle} aria-label="卡片模式 (C)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="10" rx="2" ry="2" /><path d="M6 7v10"/><path d="M18 7v10"/></svg>
                 </button>
                 <div className="ai-helper" ref={aiHelperRef}>
                    <button className="control-button" onClick={() => setIsAiHelperOpen(prev => !prev)} aria-label="AI 助手">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    </button>
                    {isAiHelperOpen && (
                        <div className="ai-helper-dropdown">
                            <button onClick={() => {
                                handleAiAction('summarize', {
                                    text: activeChapter.paragraphs.join('\n'), 
                                    context: { bookTitle: book.title, chapterTitle: activeChapter.title }
                                });
                                setIsAiHelperOpen(false);
                            }}>
                                总结本章
                            </button>
                        </div>
                    )}
                 </div>
                <DisplaySettingsComponent
                    theme={theme}
                    onThemeChange={onThemeChange}
                    typography={typography}
                    onTypographyChange={onTypographyChange}
                    isOpen={isSettingsOpen}
                    setIsOpen={setIsSettingsOpen}
                    encoding={book.encoding}
                    onEncodingChange={handleEncodingChange}
                />
            </div>
        </div>
    );
};

const App = () => {
    const [books, setBooks] = useState<Book[]>([]);
    const [selectedBook, setSelectedBook] = useState<Book | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
    const [theme, setTheme] = useState(localStorage.getItem('reader-theme') || 'theme-dark');
    const [typography, setTypography] = useState<TypographySettings>(() => {
        const savedSettings = localStorage.getItem('reader-typography');
        return savedSettings ? JSON.parse(savedSettings) : { fontSize: 18, lineHeight: 1.9, fontFamily: 'sans-serif' };
    });
    const aiRef = useRef<GoogleGenAI | null>(null);

    useEffect(() => {
        if (process.env.API_KEY) {
            aiRef.current = new GoogleGenAI({ apiKey: process.env.API_KEY });
        } else {
            console.warn("API_KEY environment variable not set. AI features will be disabled.");
        }
    }, []);

    useEffect(() => {
        db.getBooks().then(setBooks);
        document.body.className = theme;
        localStorage.setItem('reader-theme', theme);
    }, [theme]);
    
    useEffect(() => {
        localStorage.setItem('reader-typography', JSON.stringify(typography));
    }, [typography]);

    const handleImportBook = (file: File) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const arrayBuffer = e.target?.result as ArrayBuffer;
            if (!arrayBuffer) return;

            let encoding: string;
            try {
                // Try decoding with UTF-8, with `fatal: true` to throw on errors
                new TextDecoder('utf-8', { fatal: true }).decode(arrayBuffer);
                encoding = 'utf-8';
            } catch (error) {
                // If UTF-8 fails, fall back to GBK
                encoding = 'gbk';
            }
            
            const title = file.name.replace(/\.txt$/i, '');
            const newBook: Book = {
                id: Date.now(),
                title,
                author: '未知作者',
                fileBlob: new Blob([arrayBuffer]),
                encoding,
                lastReadChapterIndex: 0,
                lastReadParagraphIndex: 0,
                bookmarks: [],
            };

            db.addBook(newBook).then(() => {
                setBooks(prev => [...prev, newBook]);
            }).catch(err => {
                console.error("Failed to add book to DB", err);
                alert("导入书籍失败！");
            });
        };
        reader.readAsArrayBuffer(file);
    };


    const handleUpdateBook = useCallback(async (updatedBook: Book) => {
        if (updatedBook.isTemporary) return;
        try {
            await db.updateBook(updatedBook);
            setBooks(prevBooks => prevBooks.map(b => b.id === updatedBook.id ? updatedBook : b));
            setSelectedBook(prevSelectedBook => 
                (prevSelectedBook && prevSelectedBook.id === updatedBook.id) ? updatedBook : prevSelectedBook
            );
        } catch (err) {
            console.error("Failed to update book", err);
            alert("更新书籍失败！");
        }
    }, []);

    const handleShowContextMenu = (event: React.MouseEvent, bookId: number) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, bookId });
    };

    const handleCloseContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    useEffect(() => {
        window.addEventListener('click', handleCloseContextMenu);
        return () => {
            window.removeEventListener('click', handleCloseContextMenu);
        };
    }, [handleCloseContextMenu]);

    const handleDeleteBook = (bookId: number) => {
        db.deleteBook(bookId).then(() => {
            setBooks(prev => prev.filter(b => b.id !== bookId));
            setContextMenu(null);
        });
    };

    const handleTypographyChange = (newSettings) => {
        setTypography(prev => ({ ...prev, ...newSettings }));
    };

    if (selectedBook) {
        return <ReaderView 
            book={selectedBook} 
            onBack={() => setSelectedBook(null)}
            onBookUpdate={handleUpdateBook}
            theme={theme}
            onThemeChange={setTheme}
            typography={typography}
            onTypographyChange={handleTypographyChange}
            ai={aiRef.current}
        />;
    }

    return (
        <>
            <BookshelfView
                books={books}
                onSelectBook={setSelectedBook}
                onImportBook={handleImportBook}
                onShowContextMenu={handleShowContextMenu}
            />
            <ContextMenuComponent menu={contextMenu} onSelectDelete={handleDeleteBook} />
        </>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);