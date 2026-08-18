import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/apiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchAttendanceNotes, saveAttendanceNote, deleteAttendanceNote } from '@/lib/supabaseDb';
import { normalizeEmpNoKey } from '@/lib/dashboardUtils';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  try {
    const auth = await requireApiSession(request);
    if (auth.response) return auth.response;
    const { searchParams } = new URL(request.url);
    const fromDate = searchParams.get('from') || searchParams.get('fromDate') || '';
    const toDate = searchParams.get('to') || searchParams.get('toDate') || '';
    const empNo = searchParams.get('empNo') || '';

    if (searchParams.get('image') === '1') {
      const notes = await fetchAttendanceNotes({ fromDate, toDate, empNo });
      const imageUrl = notes[0]?.image_url || '';
      if (!imageUrl) return new NextResponse('Not found', { status: 404 });
      if (imageUrl.startsWith('data:image/')) {
        const match = imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) return new NextResponse('Invalid image', { status: 422 });
        return new Response(Buffer.from(match[2], 'base64'), { headers: { 'Content-Type': match[1], 'Cache-Control': 'private, max-age=300' } });
      }
      return NextResponse.redirect(imageUrl, { status: 307 });
    }

    const notes = await fetchAttendanceNotes({ fromDate, toDate, empNo });
    return NextResponse.json({ success: true, notes });
  } catch (error) {
    console.error('GET /api/attendance-notes error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { empNo, workDate, note, imageBase64, imageName, imageUrl: explicitImageUrl } = body;

    if (!empNo || !workDate) {
      return NextResponse.json({ success: false, error: '삼번 일자는 핑수임니다.' }, { status: 400 });
    }

    let finalImageUrl = explicitImageUrl || null;

    if (imageBase64 && imageBase64.startsWith('data:image/')) {
      try {
        const matches = imageBase64.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          const cleanEmp = normalizeEmpNoKey(empNo);
          const fileName = `${cleanEmp}_${workDate}_${Date.now()}.${ext}`;

          const bucketName = 'attendance-notes';
          const { data: buckets } = await supabaseAdmin.storage.listBuckets();
          const existingBucket = buckets?.find(b => b.name === bucketName);
          if (!existingBucket) {
            await supabaseAdmin.storage.createBucket(bucketName, { public: false });
          } else if (existingBucket.public) {
            await supabaseAdmin.storage.updateBucket(bucketName, { public: false });
          }

          const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
            .from(bucketName)
            .upload(fileName, buffer, {
              contentType: `image/${matches[1]}`,
              upsert: true,
            });

          if (!uploadError && uploadData) {
            // Keep only a storage reference in the database. The read API
            // converts it to a short-lived signed URL for authenticated users.
            finalImageUrl = `storage://${bucketName}/${fileName}`;
          } else {
            console.warn('Storage upload warning:', uploadError?.message);
            finalImageUrl = imageBase64;
          }
        }
      } catch (uploadErr) {
        console.error('Image upload failed, fallback to base64:', uploadErr);
        finalImageUrl = imageBase64;
      }
    }

    const saved = await saveAttendanceNote({
      empNo,
      workDate,
      note: note || '',
      imageUrl: finalImageUrl,
    });

    return NextResponse.json({ success: true, note: saved });
  } catch (error) {
    console.error('POST /api/attendance-notes error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const empNo = searchParams.get('empNo');
    const workDate = searchParams.get('workDate') || searchParams.get('date');

    if (!empNo || !workDate) {
      return NextResponse.json({ success: false, error: 'sabun_and_date_required' }, { status: 400 });
    }

    await deleteAttendanceNote({ empNo, workDate });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/attendance-notes error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
