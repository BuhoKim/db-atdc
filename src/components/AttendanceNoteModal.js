'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Upload, Trash2, Image as ImageIcon, Check, Loader2 } from 'lucide-react';

export default function AttendanceNoteModal({ isOpen, onClose, empNo, empName, dept, workDate, initialNote = '', initialImageUrl = null, onSaved }) {
  const [note, setNote] = useState('');
  const [imageUrl, setImageUrl] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setNote(initialNote || '');
      setImageUrl(initialImageUrl || null);
      setImageBase64(null);
      setImagePreview(initialImageUrl || null);
      setError(null);
      const isSystemMemo = initialNote && (initialNote.includes('기록') || initialNote.includes('출근 (') || initialNote.includes('퇴근 ('));
      if (isSystemMemo) setNote('');

      if (empNo && workDate) {
        const cleanDate = String(workDate).slice(0, 10).replace(/\./g, '-');
        fetch('/api/attendance-notes?empNo=' + empNo + '&from=' + cleanDate + '&to=' + cleanDate)
          .then(r => r.json())
          .then(d => {
            if (d?.notes?.length > 0) {
              setNote(d.notes[0].note || '');
              setImageUrl(d.notes[0].image_url || null);
              setImagePreview(d.notes[0].image_url || null);
            }
          })
          .catch(() => {});
      }
    }
  }, [isOpen, empNo, workDate, initialNote, initialImageUrl]);

  const handleFile = (file) => {
    if (!file || !file.type.startsWith('image/')) { setError('이미지 파일만 첨부 가능합니다.'); return; }
    if (file.size > 5 * 1024 * 1024) { setError('5MB 이하 파일만 가능합니다.'); return; }
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => { setImageBase64(e.target.result); setImagePreview(e.target.result); setImageUrl(null); };
    reader.readAsDataURL(file);
  };

  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) { const file = items[i].getAsFile(); if (file) { handleFile(file); break; } }
    }
  }, []);

  const handleSave = async () => {
    if (!empNo || !workDate) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/attendance-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empNo, workDate, note: note.trim(), imageBase64, imageUrl: imageBase64 ? null : imageUrl }),
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || '저장 실패');
      if (onSaved) onSaved({ empNo, workDate, note: d.note?.note || note.trim(), imageUrl: d.note?.image_url || imagePreview });
      onClose();
    } catch (err) { setError(err.message || '저장 오류'); } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm('사유를 삭제하시겠습니까?')) return;
    setDeleting(true); setError(null);
    try {
      const res = await fetch('/api/attendance-notes?empNo=' + empNo + '&workDate=' + workDate, { method: 'DELETE' });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || '삭제 실패');
      if (onSaved) onSaved({ empNo, workDate, note: '', imageUrl: null });
      onClose();
    } catch (err) { setError(err.message || '삭제 오류'); } finally { setDeleting(false); }
  };

  if (!isOpen) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} onPaste={handlePaste}>
      <div style={{ backgroundColor: 'var(--card-bg, #ffffff)', color: 'var(--text-main, #1e293b)', borderRadius: 16, width: '100%', maxWidth: 520, border: '1px solid var(--border-color, #e2e8f0)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border-color, #e2e8f0)', backgroundColor: 'var(--subtle-bg, #f8fafc)' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>📝 지각 / 출근누락 사유 등록</h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: 'var(--text-secondary, #64748b)' }}>{workDate} | {empName || empNo} {dept ? '(' + dept + ')' : ''}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6 }}><X size={20} /></button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <div style={{ padding: '8px 12px', borderRadius: 8, backgroundColor: '#fef2f2', color: '#dc2626', fontSize: '0.85rem' }}>{error}</div>}
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: 6 }}>사유 및 메모</label>
            <textarea rows={4} value={note} onChange={e => setNote(e.target.value)} placeholder='사유를 입력하세요 (예: 출근 태그 누락, 8시 55분 슬랙 도착 확인 등)' style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--border-color, #cbd5e1)', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ fontSize: '0.875rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><ImageIcon size={16} /> 증빙 이미지</label>
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Ctrl+V 붙여넣기 지원</span>
            </div>
            {imagePreview ? (
              <div style={{ position: 'relative', borderRadius: 8, border: '1px solid var(--border-color, #e2e8f0)', overflow: 'auto', maxHeight: 360, display: 'flex', justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' }}>
                <img src={imagePreview} alt='증빙' style={{ display: 'block', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />
                <button type='button' onClick={() => { setImageUrl(null); setImageBase64(null); setImagePreview(null); }} style={{ position: 'absolute', top: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.7)', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 8px', fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Trash2 size={12} /> 삭제</button>
              </div>
            ) : (
              <div style={{ border: '2px dashed var(--border-color, #cbd5e1)', borderRadius: 8, padding: 20, textAlign: 'center', cursor: 'pointer', backgroundColor: 'var(--subtle-bg, #f8fafc)' }} onClick={() => document.getElementById('att-file-input')?.click()}>
                <Upload size={20} style={{ color: '#94a3b8', margin: '0 auto 6px' }} />
                <p style={{ margin: '0 0 2px', fontSize: '0.85rem', fontWeight: 500 }}>이미지 클릭하여 업로드</p>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#94a3b8' }}>PNG, JPG, WebP | 캡처 후 Ctrl+V</p>
                <input id='att-file-input' type='file' accept='image/*' style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderTop: '1px solid var(--border-color, #e2e8f0)', backgroundColor: 'var(--subtle-bg, #f8fafc)' }}>
          <div>
            {(initialNote || initialImageUrl) && (
              <button type='button' onClick={handleDelete} disabled={deleting || saving} style={{ backgroundColor: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                {deleting ? <Loader2 size={14} className='animate-spin' /> : <Trash2 size={14} />} 사유 삭제
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type='button' onClick={onClose} style={{ backgroundColor: 'transparent', border: '1px solid var(--border-color, #cbd5e1)', borderRadius: 8, padding: '6px 14px', fontSize: '0.85rem', cursor: 'pointer' }}>취소</button>
            <button type='button' onClick={handleSave} disabled={saving || deleting} style={{ backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: 8, padding: '6px 16px', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              {saving ? <Loader2 size={14} className='animate-spin' /> : <Check size={14} />} 저장하기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
