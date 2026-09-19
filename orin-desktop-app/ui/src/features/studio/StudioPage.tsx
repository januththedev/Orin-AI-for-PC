import { useState } from 'react'
import { Palette, Monitor, Presentation, FileText, Smartphone, PenTool } from 'lucide-react'
import { useChatsStore } from '../../stores/chatsStore'
import { useUiStore } from '../../stores/uiStore'
import './studio.css'

interface StudioType {
  id: string
  label: string
  hint: string
  icon: typeof Palette
  brief: (topic: string) => string
}

const TYPES: StudioType[] = [
  {
    id: 'landing',
    label: 'Landing page',
    hint: 'Hero, features, pricing, FAQ in one file',
    icon: Monitor,
    brief: (topic) =>
      `Build a complete single-file landing page for: ${topic}\n\nRules: one self-contained HTML file, inline CSS only, system fonts, amber accent #e08a3c on near-black. Sections: sticky nav, hero with headline + CTA, 3 feature cards, pricing table, FAQ, footer. Responsive, no external assets.`,
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    hint: 'KPI cards, charts, tables, dark theme',
    icon: Palette,
    brief: (topic) =>
      `Build a single-file admin dashboard for: ${topic}\n\nRules: one self-contained HTML file, inline CSS + vanilla JS only. KPI stat cards, a bar chart drawn with divs, a data table with sortable columns, sidebar nav. Near-black background, amber #e08a3c highlights. Include 8+ rows of realistic sample data.`,
  },
  {
    id: 'deck',
    label: 'Slide deck',
    hint: 'Title, agenda, content, closing slides',
    icon: Presentation,
    brief: (topic) =>
      `Build a slide deck as one HTML file about: ${topic}\n\nRules: single file, each slide a full-viewport section, arrow-key navigation with a tiny inline script, slide counter. Slides: title, agenda, 3 content slides with bullets, closing CTA. Near-black, amber #e08a3c accents, big type.`,
  },
  {
    id: 'document',
    label: 'Document',
    hint: 'Guides, specs, reports with TOC',
    icon: FileText,
    brief: (topic) =>
      `Write a polished multi-section document about: ${topic}\n\nRules: single HTML file, table of contents with anchor links, clear headings, summary box at top, readable line length. Answer in the document itself, not in chat.`,
  },
  {
    id: 'mobile',
    label: 'Mobile screen',
    hint: 'Phone-frame UI flows',
    icon: Smartphone,
    brief: (topic) =>
      `Design a mobile app screen flow for: ${topic}\n\nRules: single HTML file showing 3 phone frames (375px) side by side: main screen, detail screen, settings screen. Bottom tab bars, realistic content. Near-black UI with amber #e08a3c accents.`,
  },
  {
    id: 'brand',
    label: 'Brand kit',
    hint: 'Palette, type scale, components',
    icon: PenTool,
    brief: (topic) =>
      `Create a brand kit page for: ${topic}\n\nRules: single HTML file showing the color palette with hex codes, a type scale (display/head/body/caption), button variants, card and input components. Everything rendered live in CSS, documented beside each piece.`,
  },
]

export default function StudioPage() {
  const [brief, setBrief] = useState('')
  const [typeId, setTypeId] = useState(TYPES[0].id)
  const setView = useUiStore((state) => state.setView)

  const selected = TYPES.find((t) => t.id === typeId) ?? TYPES[0]

  const create = () => {
    const topic = brief.trim() || 'a sample product'
    const store = useChatsStore.getState()
    store.createChat('agent')
    store.sendMessage(selected.brief(topic))
    setView('chat')
  }

  return (
    <div className="studio-page">
      <header className="page-header">
        <h1 className="page-title">Studio</h1>
        <span className="setting-hint">Describe it — Orin designs and builds it as a real file.</span>
      </header>

      <div className="studio-types">
        {TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`studio-type ${t.id === typeId ? 'active' : ''}`}
            onClick={() => setTypeId(t.id)}
          >
            <t.icon size={20} />
            <strong>{t.label}</strong>
            <span>{t.hint}</span>
          </button>
        ))}
      </div>

      <textarea
        className="studio-brief"
        placeholder={`What should the ${selected.label.toLowerCase()} be about?`}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={3}
      />

      <div className="studio-actions">
        <button type="button" className="button-primary" onClick={create}>
          Create in chat
        </button>
        <span className="setting-hint">Opens a build conversation with the brief filled in.</span>
      </div>
    </div>
  )
}
