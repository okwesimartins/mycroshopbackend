const { Sequelize } = require('sequelize');
const moment = require('moment');

/**
 * Clock in staff member
 */
async function clockIn(req, res) {
  try {
    const {
      staff_id,
      store_id,
      attendance_method = 'mobile', // Default to mobile app
      device_id,
      location_latitude,
      location_longitude
    } = req.body;

    if (!staff_id) {
      return res.status(400).json({
        success: false,
        message: 'staff_id is required'
      });
    }

    // Check if staff already clocked in today
    const today = moment().format('YYYY-MM-DD');
    const existingAttendance = await req.db.models.StaffAttendance.findOne({
      where: {
        staff_id,
        clock_in_time: {
          [Sequelize.Op.gte]: moment(today).startOf('day').toDate()
        },
        clock_out_time: null
      }
    });

    if (existingAttendance) {
      return res.status(400).json({
        success: false,
        message: 'Staff already clocked in today',
        data: { attendance: existingAttendance }
      });
    }

    // Get staff shift if exists
    const shift = await req.db.models.StaffShift.findOne({
      where: {
        staff_id,
        shift_date: today,
        is_approved: true
      }
    });

    // Check if late
    let status = 'present';
    if (shift) {
      const shiftStart = moment(`${today} ${shift.shift_start_time}`, 'YYYY-MM-DD HH:mm:ss');
      const clockInTime = moment();
      if (clockInTime.isAfter(shiftStart.add(15, 'minutes'))) {
        status = 'late';
      }
    }

    const attendance = await req.db.models.StaffAttendance.create({
      staff_id,
      store_id: store_id || null,
      clock_in_time: new Date(),
      attendance_method,
      device_id: device_id || null,
      location_latitude: location_latitude || null,
      location_longitude: location_longitude || null,
      status
    });

    const completeAttendance = await req.db.models.StaffAttendance.findByPk(attendance.id, {
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Clocked in successfully',
      data: { attendance: completeAttendance }
    });
  } catch (error) {
    console.error('Error clocking in:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clock in'
    });
  }
}

/**
 * Clock out staff member
 */
async function clockOut(req, res) {
  try {
    const { attendance_id, notes } = req.body;

    if (!attendance_id) {
      return res.status(400).json({
        success: false,
        message: 'attendance_id is required'
      });
    }

    const attendance = await req.db.models.StaffAttendance.findByPk(attendance_id);

    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'Attendance record not found'
      });
    }

    if (attendance.clock_out_time) {
      return res.status(400).json({
        success: false,
        message: 'Already clocked out'
      });
    }

    const clockOutTime = new Date();
    const clockInTime = moment(attendance.clock_in_time);
    const totalHours = moment(clockOutTime).diff(clockInTime, 'hours', true);
    const breakDuration = attendance.break_duration || 0;
    const workHours = totalHours - (breakDuration / 60);

    // Check for early leave
    let status = attendance.status;
    const shift = await req.db.models.StaffShift.findOne({
      where: {
        staff_id: attendance.staff_id,
        shift_date: moment(attendance.clock_in_time).format('YYYY-MM-DD'),
        is_approved: true
      }
    });

    if (shift) {
      const shiftEnd = moment(`${moment(attendance.clock_in_time).format('YYYY-MM-DD')} ${shift.shift_end_time}`, 'YYYY-MM-DD HH:mm:ss');
      if (moment(clockOutTime).isBefore(shiftEnd.subtract(30, 'minutes'))) {
        status = 'early_leave';
      }
    }

    await attendance.update({
      clock_out_time: clockOutTime,
      total_hours: totalHours.toFixed(2),
      work_duration: workHours.toFixed(2),
      break_duration: breakDuration,
      status,
      notes: notes || attendance.notes
    });

    const updatedAttendance = await req.db.models.StaffAttendance.findByPk(attendance.id, {
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ]
    });

    res.json({
      success: true,
      message: 'Clocked out successfully',
      data: { attendance: updatedAttendance }
    });
  } catch (error) {
    console.error('Error clocking out:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clock out'
    });
  }
}

/**
 * Get staff attendance records
 */
async function getStaffAttendance(req, res) {
  try {
    const { staff_id, store_id, start_date, end_date, status } = req.query;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (staff_id) where.staff_id = staff_id;
    if (store_id) where.store_id = store_id;
    if (status) where.status = status;
    if (start_date || end_date) {
      where.clock_in_time = {};
      if (start_date) where.clock_in_time[Sequelize.Op.gte] = start_date;
      if (end_date) where.clock_in_time[Sequelize.Op.lte] = end_date;
    }

    const { count, rows } = await req.db.models.StaffAttendance.findAndCountAll({
      where,
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['clock_in_time', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        attendance_records: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error getting attendance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get attendance records'
    });
  }
}

/**
 * Get current clocked-in staff
 */
async function getClockedInStaff(req, res) {
  try {
    const { store_id } = req.query;

    const where = {
      clock_out_time: null
    };
    if (store_id) where.store_id = store_id;

    const clockedInStaff = await req.db.models.StaffAttendance.findAll({
      where,
      include: [
        {
          model: req.db.models.Staff,
          attributes: ['id', 'name', 'employee_id', 'role_id']
        },
        {
          model: req.db.models.Store,
          attributes: ['id', 'name']
        }
      ],
      order: [['clock_in_time', 'DESC']]
    });

    res.json({
      success: true,
      data: { clocked_in_staff: clockedInStaff }
    });
  } catch (error) {
    console.error('Error getting clocked-in staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get clocked-in staff'
    });
  }
}

/**
 * Record break
 */
async function recordBreak(req, res) {
  try {
    const { attendance_id, action } = req.body; // action: 'start' or 'end'

    if (!attendance_id || !action) {
      return res.status(400).json({
        success: false,
        message: 'attendance_id and action (start/end) are required'
      });
    }

    const attendance = await req.db.models.StaffAttendance.findByPk(attendance_id);

    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'Attendance record not found'
      });
    }

    if (action === 'start') {
      await attendance.update({
        break_start_time: new Date()
      });
    } else if (action === 'end') {
      if (!attendance.break_start_time) {
        return res.status(400).json({
          success: false,
          message: 'Break not started'
        });
      }

      const breakEnd = new Date();
      const breakStart = moment(attendance.break_start_time);
      const breakDuration = moment(breakEnd).diff(breakStart, 'minutes');

      await attendance.update({
        break_end_time: breakEnd,
        break_duration: (attendance.break_duration || 0) + breakDuration
      });
    }

    res.json({
      success: true,
      message: `Break ${action === 'start' ? 'started' : 'ended'} successfully`,
      data: { attendance }
    });
  } catch (error) {
    console.error('Error recording break:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to record break'
    });
  }
}

/**
 * Get attendance summary
 */
async function getAttendanceSummary(req, res) {
  try {
    const { staff_id, start_date, end_date } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'start_date and end_date are required'
      });
    }

    const where = {
      staff_id,
      clock_in_time: {
        [Sequelize.Op.between]: [start_date, end_date]
      }
    };

    const attendanceRecords = await req.db.models.StaffAttendance.findAll({
      where,
      attributes: [
        [Sequelize.fn('SUM', Sequelize.col('work_duration')), 'total_hours'],
        [Sequelize.fn('COUNT', Sequelize.col('id')), 'days_worked'],
        [Sequelize.fn('SUM', Sequelize.case()
          .when({ status: 'late' }, 1)
          .else(0)
        ), 'late_count'],
        [Sequelize.fn('SUM', Sequelize.case()
          .when({ status: 'absent' }, 1)
          .else(0)
        ), 'absent_count']
      ],
      raw: true
    });

    res.json({
      success: true,
      data: {
        period: { start_date, end_date },
        summary: attendanceRecords[0] || {
          total_hours: 0,
          days_worked: 0,
          late_count: 0,
          absent_count: 0
        }
      }
    });
  } catch (error) {
    console.error('Error getting attendance summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get attendance summary'
    });
  }
}

module.exports = {
  clockIn,
  clockOut,
  getStaffAttendance,
  getClockedInStaff,
  recordBreak,
  getAttendanceSummary
};

